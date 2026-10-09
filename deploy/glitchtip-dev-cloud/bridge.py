"""Read-only GlitchTip reconciliation -> signed minimal dev API summaries.

SDK ingestion never waits for this bridge. A durable acknowledgement journal
prevents needless re-sends. Cursor moves only after the entire page is delivered.
The head is checked separately so a long historical scan cannot delay new errors.
"""
import hashlib
import hmac
import json
import re
import sqlite3
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = 'http://web:8000'
DESTINATION = 'https://dev.leader-product.ru/integrations/sentry/events'
PAGE_SIZE = 10
MAX_BODY = 4 * 1024 * 1024


def tag_values(event):
    tags = event.get('tags') or {}
    if isinstance(tags, dict):
        return tags
    return {t['key']: t.get('value') for t in tags if isinstance(t, dict) and 'key' in t}


def project_event(event, project):
    tags = tag_values(event)
    if (event.get('environment') or tags.get('environment')) != 'development':
        return None
    # GlitchTip uses eventId, the existing API projection expects eventID.
    event_id = event.get('eventID') or event.get('eventId') or event.get('event_id')
    if not isinstance(event_id, str) or not re.fullmatch('[a-fA-F0-9]{32}', event_id):
        raise ValueError('Missing client event ID')
    allowed_tags = ('environment', 'app_version', 'build_number', 'ota_update_id', 'runtime_version', 'screen')
    contexts = event.get('contexts') or {}
    diagnostic = {key: event[key] for key in ('dateCreated', 'timestamp', 'title', 'platform', 'dist') if key in event}
    diagnostic['dist'] = event.get('dist') or tags.get('build_number')
    diagnostic.update({
        'eventID': event_id.lower(), 'environment': 'development',
        'level': event.get('level') or tags.get('level', 'error'),
        'release': event.get('release') or tags.get('release'),
        'tags': [{'key': k, 'value': tags[k]} for k in allowed_tags if k in tags],
        'user': {'id': (event.get('user') or {}).get('id')},
        'contexts': {
            'device': {'model': (contexts.get('device') or {}).get('model')},
            'os': {'version': (contexts.get('os') or {}).get('version')},
        },
    })
    return {'project': {'slug': project}, 'group': {'id': event.get('groupID') or event.get('groupId')}, 'event': diagnostic}


class Bridge:
    def __init__(self, config, database):
        self.config = config
        self.prefix = f'/api/0/projects/{config["organization"]}/{config["project"]}/events/'
        self.first = self.prefix + '?limit=10'
        self.db = sqlite3.connect(database)
        self.db.execute('CREATE TABLE IF NOT EXISTS acknowledged (id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL, next_scan INTEGER NOT NULL)')
        self.db.commit()

    def validate_path(self, path):
        parsed = urllib.parse.urlsplit(path)
        if parsed.path != self.prefix or (parsed.netloc and parsed.netloc != urllib.parse.urlsplit(BASE).netloc):
            raise ValueError('Unexpected event cursor path/host')
        if parsed.scheme and parsed.scheme != 'http':
            raise ValueError('Unexpected cursor scheme')
        return parsed.path + '?' + parsed.query

    def read_page(self, path):
        req = urllib.request.Request(BASE + self.validate_path(path), headers={'Authorization': 'Bearer ' + self.config['readToken']})
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                raise ValueError('Event page too large')
            events = json.loads(raw)
            if not isinstance(events, list) or len(events) > PAGE_SIZE:
                raise ValueError('Unexpected event page')
            return events, response.headers.get('Link', '')

    def following(self, link):
        for part in link.split(','):
            if 'rel="next"' in part and 'results="true"' in part:
                match = re.search(r'<([^>]+)>', part)
                if not match:
                    raise ValueError('Invalid pagination')
                return self.validate_path(match.group(1))
        return None

    def send(self, payload):
        raw = json.dumps(payload, separators=(',', ':')).encode()
        signature = hmac.new(self.config['webhookSecret'].encode(), raw, hashlib.sha256).hexdigest()
        req = urllib.request.Request(DESTINATION, raw, headers={'Content-Type': 'application/json', 'X-ServiceHook-Signature': signature}, method='POST')
        with urllib.request.urlopen(req, timeout=15) as response:
            if response.status != 204:
                raise ValueError('Not durably acknowledged')

    def read_level(self, event):
        # The list schema omits severity; read the JSON endpoint for NEW events.
        # Its other fields (stack, breadcrumbs, request) are never forwarded/stored.
        issue = str(event.get('groupId') or event.get('groupID') or '')
        event_id = event.get('id', '')
        if not re.fullmatch('[0-9]+', issue) or not re.fullmatch('[a-fA-F0-9]{32}', event_id):
            raise ValueError('Invalid detail identity')
        path = f'/api/0/organizations/{self.config["organization"]}/issues/{issue}/events/{event_id}/json/'
        req = urllib.request.Request(BASE + path, headers={'Authorization': 'Bearer ' + self.config['readToken']})
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                raise ValueError('Event detail too large')
            level = json.loads(raw).get('level')
            if level not in ('fatal', 'error', 'warning', 'info', 'debug'):
                raise ValueError('Invalid severity')
            return level

    def deliver(self, events):
        for event in events:
            payload = project_event(event, self.config['project'])
            if payload is None:
                continue
            event_id = payload['event']['eventID']
            # Versioned acknowledgements permit a bounded recheck after changes.
            # API keeps first-write metadata and deduplicates repeated delivery.
            ack_id = 'v2:' + event_id
            if self.db.execute('SELECT 1 FROM acknowledged WHERE id=?', (ack_id,)).fetchone():
                continue
            payload['event']['level'] = event.get('level') or self.read_level(event)
            self.send(payload)
            with self.db:
                self.db.execute('INSERT OR IGNORE INTO acknowledged VALUES (?, ?)', (ack_id, int(time.time())))

    def scan(self):
        now = int(time.time())
        state = self.db.execute('SELECT cursor, next_scan FROM state WHERE id=1').fetchone()
        if state and now < state[1]:
            return
        events, link = self.read_page(state[0] if state else self.first)
        self.deliver(events)
        following = self.following(link)
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO state VALUES (1, ?, ?)', (following or self.first, now + (5 if following else 300)))
            self.db.execute('DELETE FROM acknowledged WHERE at < ?', (now - 32 * 86400,))
        print(f'[crash-bridge] page acknowledged ({len(events)} events)', flush=True)


def main():
    cfg = json.loads(Path('/run/secrets/bridge.json').read_text())
    if cfg['project'] != 'leader-app-dev':
        raise ValueError('Dev-only guard')
    bridge = Bridge(cfg, '/state/bridge.sqlite3')
    next_head = 0
    while True:
        try:
            if time.time() >= next_head:
                events, _ = bridge.read_page(bridge.first)
                bridge.deliver(events)
                next_head = time.time() + 60
            bridge.scan()
            time.sleep(5)
        except Exception as error:
            # Never log request URLs, tokens, exception messages or event payloads.
            print(f'[crash-bridge] deferred ({type(error).__name__})', flush=True)
            time.sleep(60)


if __name__ == '__main__':
    main()
