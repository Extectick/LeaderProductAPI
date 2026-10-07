"""Activate only dev after Sentry bootstrap. Secrets provided on stdin, never logged."""
import json
import os
import re
import sys
from pathlib import Path
from shutil import copy2

config = json.load(sys.stdin)
assert config['project'] == 'leader-app-dev'
assert len(config['webhookSecret']) >= 32
root = Path('/opt/leader-api-dev')
env = root / '.env'
assert (root / 'docker-compose.server-dev.yml').is_file()
content = env.read_text()
settings = {
    'APP_CRASH_REPORTING_ENABLED': 'true',
    'SENTRY_PROJECT_SLUG': config['project'],
    'SENTRY_EXPECTED_ENVIRONMENT': 'development',
    'SENTRY_WEBHOOK_SECRET': config['webhookSecret'],
    'DB_ACCEPT_DATA_LOSS': '0',
}
for name, value in settings.items():
    assert re.fullmatch(r'[A-Za-z0-9_-]+', value)
    line = f'{name}={value}'
    if re.search(rf'^{name}=.*$', content, re.M):
        content = re.sub(rf'^{name}=.*$', line, content, flags=re.M)
    else:
        content += '\n' + line + '\n'
env.write_text(content)
os.chmod(env, 0o600)

nginx = Path('/etc/nginx/sites-available/dev.leader-product.ru')
assert nginx.exists()
backup = nginx.with_name(nginx.name + '.before-sentry-20260921')
if not backup.exists(): copy2(nginx, backup)
source = nginx.read_text()
include = '    include /opt/leader-api-dev/deploy/sentry-dev/nginx-ingest.conf;'
if include not in source:
    assert source.count('    client_max_body_size 100m;') == 1
    source = source.replace('    client_max_body_size 100m;', '    client_max_body_size 100m;\n\n' + include)
nginx.write_text(source)
copy2(root / 'deploy/sentry-dev/nginx-rate-limit.conf', '/etc/nginx/conf.d/leader-sentry-dev-rate-limit.conf')
print('Dev crash-report configuration prepared; validate nginx before reload')
