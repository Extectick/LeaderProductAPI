"""One-time dev-only nginx/env setup. Does not restart API or touch production."""
from pathlib import Path
import datetime
import os
import shutil
import subprocess

root = Path('/opt/leader-api-dev')
assert root.is_dir(), 'Run on the dev API host'
config = Path('/etc/nginx/sites-available/dev.leader-product.ru')
assert config.is_file() and 'server_name dev.leader-product.ru;' in config.read_text()
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = root / 'backups' / ('public-order-config-' + stamp)
backup.mkdir(mode=0o700)
env = root / '.env'
shutil.copy2(env, backup / 'env')
os.chmod(backup / 'env', 0o600)
shutil.copy2(config, backup / 'nginx-dev.conf')
values = {'ORDER_SHARING_ENABLED': '1', 'ORDER_SHARE_PUBLIC_ORIGIN': 'https://dev.leader-product.ru'}
lines = [line for line in env.read_text().splitlines() if line.split('=', 1)[0] not in values]
temp = root / '.env.order-share-next'
temp.write_text('\n'.join(lines + [key + '=' + value for key, value in values.items()]) + '\n')
os.chmod(temp, 0o600)
os.replace(temp, env)
Path('/var/www/leader-order-dev/releases').mkdir(parents=True, exist_ok=True)
snippet = Path('/etc/nginx/snippets/leader-public-order-dev.conf')
source = Path(__file__).resolve().parent.parent / 'deploy/nginx-public-order-dev.conf'
if snippet.exists(): shutil.copy2(snippet, backup / 'snippet.conf')
shutil.copy2(source, snippet)
limits = Path('/etc/nginx/conf.d/leader-public-order-dev-limit.conf')
expected = 'limit_req_zone $binary_remote_addr zone=leader_order_dev:10m rate=10r/s;\n'
assert not limits.exists() or limits.read_text() == expected, 'Unexpected existing rate-limit configuration'
limits.write_text(expected)
include = '    include /etc/nginx/snippets/leader-public-order-dev.conf;'
original = config.read_text()
if include not in original:
    config.write_text(original.replace('    client_max_body_size 100m;', '    client_max_body_size 100m;\n' + include, 1))
try:
    subprocess.run(['nginx', '-t'], check=True)
except Exception:
    shutil.copy2(backup / 'nginx-dev.conf', config)
    shutil.copy2(backup / 'env', env)
    if (backup / 'snippet.conf').exists(): shutil.copy2(backup / 'snippet.conf', snippet)
    raise
subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
print('Dev-only setup complete; backup:', backup)
