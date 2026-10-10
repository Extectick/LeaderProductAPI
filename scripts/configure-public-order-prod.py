"""Explicit, backed-up production sharing setup; no API restart or dev changes."""
from pathlib import Path
import datetime
import os
import secrets
import shutil
import subprocess

root = Path('/opt/leader-api')
env = root / '.env'
config = Path('/etc/nginx/sites-available/leader-product-api')
assert root.is_dir() and env.is_file()
original = config.read_text()
assert original.count('server_name api.leader-product.ru;') == 2
assert original.count('    client_max_body_size 100m;') == 1
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = Path('/var/backups') / ('leader-public-order-prod-' + stamp)
backup.mkdir(mode=0o700)
snippet = Path('/etc/nginx/snippets/leader-public-order-prod.conf')
limits = Path('/etc/nginx/conf.d/leader-public-order-prod-limit.conf')
targets = [env, config, snippet, limits]
existing = {}
for index, target in enumerate(targets):
    existing[target] = target.exists()
    if target.exists():
        shutil.copy2(target, backup / str(index))
        os.chmod(backup / str(index), 0o600)
source = Path(__file__).resolve().parent.parent / 'deploy/nginx-public-order-prod.conf'
assert source.is_file()
try:
    values = {'ORDER_SHARING_ENABLED': '1', 'ORDER_SHARE_PUBLIC_ORIGIN': 'https://api.leader-product.ru'}
    lines = env.read_text().splitlines()
    current = dict(line.split('=', 1) for line in lines if '=' in line and not line.startswith('#'))
    assert current.get('DB_ACCEPT_DATA_LOSS') == '0', 'Destructive schema sync must be disabled'
    if not current.get('ORDER_SHARE_SECRET'):
        values['ORDER_SHARE_SECRET'] = secrets.token_urlsafe(48)
    lines = [line for line in lines if line.split('=', 1)[0] not in values]
    temp = root / '.env.public-order-next'
    temp.write_text('\n'.join(lines + [key + '=' + value for key, value in values.items()]) + '\n')
    os.chmod(temp, 0o600)
    os.replace(temp, env)
    Path('/var/www/leader-order-prod/releases').mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, snippet)
    expected = 'limit_req_zone $binary_remote_addr zone=leader_order_prod:10m rate=10r/s;\n'
    assert not limits.exists() or limits.read_text() == expected
    limits.write_text(expected)
    include = '    include /etc/nginx/snippets/leader-public-order-prod.conf;'
    if include not in original:
        config.write_text(original.replace('    client_max_body_size 100m;', '    client_max_body_size 100m;\n' + include, 1))
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
except Exception:
    for index, target in enumerate(targets):
        if existing[target]:
            shutil.copy2(backup / str(index), target)
        elif target in (snippet, limits) and target.exists():
            target.unlink()
    raise
print('Production sharing configured; protected config backup:', backup)
