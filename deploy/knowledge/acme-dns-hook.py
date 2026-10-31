#!/usr/bin/env python3
"""Wait for an operator-created DNS record. This is not automatic renewal."""
import json
import os
from pathlib import Path
import subprocess
import time

domain = os.environ['CERTBOT_DOMAIN']
if domain != 'cloud.leader-product.ru':
    raise SystemExit('Unexpected certificate domain')
value = os.environ['CERTBOT_VALIDATION']
record = '_acme-challenge.' + domain
runtime = Path(__file__).resolve().parent / 'runtime'
runtime.mkdir(mode=0o700, exist_ok=True)
challenge = {'type': 'TXT', 'name': record, 'value': value}
(runtime / 'dns-challenge.json').write_text(json.dumps(challenge), encoding='utf-8')
print(json.dumps(challenge), flush=True)
deadline = time.monotonic() + 1800
while time.monotonic() < deadline:
    ready = True
    for resolver in ('1.1.1.1', '8.8.8.8'):
        result = subprocess.run(['dig', '+time=3', '+tries=1', '+short',
                                 'TXT', record, '@' + resolver],
                                capture_output=True, text=True, timeout=10)
        ready = ready and value in [line.strip('"') for line in result.stdout.splitlines()]
    if ready:
        print('DNS challenge visible on both resolvers', flush=True)
        raise SystemExit(0)
    time.sleep(15)
raise SystemExit('DNS record did not propagate within 30 minutes')
