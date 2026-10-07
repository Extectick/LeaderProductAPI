"""Install the scoped crash-ingestion route with backup and rollback."""
import datetime
import shutil
import subprocess
from pathlib import Path

site = Path('/etc/nginx/sites-available/leader-product-api')
snippet = Path('/etc/nginx/snippets/leader-crash-prod.conf')
rate = Path('/etc/nginx/conf.d/leader-crash-prod-rate.conf')
source = Path(__file__).resolve().parent
text = site.read_text()
assert text.count('server_name api.leader-product.ru;') == 2
backup = Path('/var/backups/leader-crash-prod') / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup.mkdir(parents=True, exist_ok=False)
targets = [site, snippet, rate]
existing = {}
for target in targets:
    existing[target] = target.exists()
    if target.exists(): shutil.copy2(target, backup / target.name)
try:
    marker = '    include /etc/nginx/snippets/leader-crash-prod.conf;'
    if marker not in text:
        text = text.replace('    server_name api.leader-product.ru;', '    server_name api.leader-product.ru;\n' + marker, 1)
    site.write_text(text)
    shutil.copyfile(source / 'nginx.conf', snippet)
    shutil.copyfile(source / 'nginx-rate.conf', rate)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print('Production crash ingestion installed; backup: ' + str(backup))
except BaseException:
    for target in targets:
        if existing[target]: shutil.copy2(backup / target.name, target)
        else: target.unlink(missing_ok=True)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    raise
