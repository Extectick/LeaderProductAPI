"""Bounded, resumable reconciliation. SDK -> Sentry remains independent of our API."""
import hashlib
import hmac
import json
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

config = json.loads(Path('/run/secrets/bridge.json').read_text())
state_file = Path('/state/cursor.json')
project = config['project']
prefix = f'/api/0/projects/{config["organization"]}/{project}/events/'
first_page = prefix + '?full=true&per_page=10&statsPeriod=30d'
base = 'http://web:9000'
destination = 'https://dev.leader-product.ru/integrations/sentry/events'


def read_page(path):
    # Sentry cursors are opaque. Never follow a different host/path from Link.
    parsed = urllib.parse.urlsplit(path)
    if parsed.path != prefix:
        raise ValueError('Unexpected event cursor path')
    req = urllib.request.Request(base + parsed.path + '?' + parsed.query,
                                 headers={'Authorization': 'Bearer ' + config['readToken']})
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError('Event page too large')
        return json.loads(raw), response.headers.get('Link', '')


def next_page(link):
    for part in link.split(','):
        if 'rel="next"' in part and 'results="true"' in part:
            found = re.search(r'<([^>]+)>', part)
            if found:
                url = urllib.parse.urlsplit(found.group(1))
                if url.path == prefix:
                    return url.path + '?' + url.query
    return first_page


def send_event(event):
    # Avoid transferring request bodies, stack locals, breadcrumbs or attachments.
    allowed = ('eventID', 'event_id', 'dateCreated', 'timestamp', 'title', 'message',
               'environment', 'tags', 'level', 'platform', 'release', 'dist')
    diagnostic = {key: event[key] for key in allowed if key in event}
    diagnostic['user'] = {'id': (event.get('user') or {}).get('id')}
    contexts = event.get('contexts') or {}
    diagnostic['contexts'] = {
        'device': {'model': (contexts.get('device') or {}).get('model')},
        'os': {'version': (contexts.get('os') or {}).get('version')},
    }
    payload = json.dumps({'project': {'slug': project},
                          'group': {'id': event.get('groupID') or event.get('groupId')},
                          'event': diagnostic}, separators=(',', ':')).encode()
    signature = hmac.new(config['webhookSecret'].encode(), payload, hashlib.sha256).hexdigest()
    req = urllib.request.Request(destination, payload,
        headers={'Content-Type': 'application/json', 'X-ServiceHook-Signature': signature}, method='POST')
    with urllib.request.urlopen(req, timeout=15) as response:
        if response.status != 204:
            raise ValueError('Event not durably acknowledged')


while True:
    try:
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
        cursor = state.get('cursor', first_page)
        events, link = read_page(cursor)
        if not isinstance(events, list) or len(events) > 10:
            raise ValueError('Unexpected event page')
        for event in events:
            # Ignore events from other environments without blocking a scan.
            tags = {tag['key']: tag.get('value') for tag in event.get('tags', []) if isinstance(tag, dict) and 'key' in tag}
            if (event.get('environment') or tags.get('environment')) == 'development':
                send_event(event)
        following = next_page(link)
        temp = state_file.with_suffix('.tmp')
        temp.write_text(json.dumps({'cursor': following, 'lastSuccess': int(time.time())}))
        os.replace(temp, state_file)  # Advance only after every event is acknowledged.
        print(f'[crash-bridge] page acknowledged ({len(events)} events)', flush=True)
        time.sleep(300 if following == first_page else 60)
    except Exception as error:
        # No URLs/tokens/payloads in logs. Retry the same page after recovery.
        print(f'[crash-bridge] deferred ({type(error).__name__})', flush=True)
        time.sleep(60)
