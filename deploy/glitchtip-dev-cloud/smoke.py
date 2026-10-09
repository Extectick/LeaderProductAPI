"""Run on cloud host after dev-only nginx cutover. No real user identity."""
import json
import time
import uuid
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

cfg = json.loads((Path(__file__).parent / 'private/credentials.json').read_text())
assert cfg['project'] == 'leader-app-dev'
event_id = uuid.uuid4().hex
event = dict(event_id=event_id, timestamp=time.time(), environment='development',
             platform='java', level='info', message='Cloud dev diagnostic transport check (synthetic)',
             tags={'qa_smoke': 'true', 'capture_mode': 'process_exit'})
body = '\n'.join([json.dumps({'event_id': event_id, 'dsn': cfg['dsn']}),
                  json.dumps({'type': 'event'}), json.dumps(event), '']).encode()
request = urllib.request.Request(f"https://dev.leader-product.ru/sentry/api/{cfg['projectId']}/envelope/",
                                 data=body, headers={'Content-Type': 'application/x-sentry-envelope',
                                 'X-Sentry-Auth': 'Sentry sentry_version=7,sentry_key=' + urllib.parse.urlsplit(cfg['dsn']).username})
with urllib.request.urlopen(request, timeout=20) as response:
    assert response.status == 200
url = f"http://127.0.0.1:19002/api/0/projects/{cfg['organization']}/{cfg['project']}/events/{event_id}/"
for attempt in range(12):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': 'Bearer ' + cfg['readToken']}), timeout=10) as response:
            saved = json.load(response)
            assert saved.get('eventID', saved.get('eventId')) == event_id
            break
    except urllib.error.HTTPError as error:
        if error.code != 404 or attempt == 11: raise
        time.sleep(2)
for path in ['/sentry/', '/sentry/api/0/projects/']:
    try:
        urllib.request.urlopen('https://dev.leader-product.ru' + path, timeout=10)
        raise RuntimeError('Private diagnostics unexpectedly exposed')
    except urllib.error.HTTPError as error:
        assert error.code == 404
print(json.dumps({'syntheticEventId': event_id, 'ingestion': 'stored', 'privateUi': 'not exposed'}))
