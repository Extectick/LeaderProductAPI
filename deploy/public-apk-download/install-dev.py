"""Reuse the download page on dev without changing production files/config."""
import datetime
import shutil
import subprocess
from pathlib import Path

source = Path(__file__).parent
site = Path('/etc/nginx/sites-available/dev.leader-product.ru')
root = Path('/var/www/leader-product-dev-download')
snippet = Path('/etc/nginx/snippets/leader-product-dev-download.conf')
include = 'include /etc/nginx/snippets/leader-product-dev-download.conf;'
anchor = 'include /etc/nginx/snippets/leader-crash-dev-cloud.conf;'
content = site.read_text()
assert anchor in content and 'server_name dev.leader-product.ru' in content
backup = Path('/var/backups/leader-dev-download') / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup.mkdir(parents=True)
shutil.copy2(site, backup / site.name)
if root.exists(): shutil.copytree(root, backup / 'assets')
if snippet.exists(): shutil.copy2(snippet, backup / snippet.name)
root.mkdir(parents=True, exist_ok=True)
shutil.copy2(source / 'app.js', root / 'app.js')
(root / 'index.html').write_text((source / 'index.html').read_text().replace('Лидер Продукт для Android', 'Лидер Продукт DEV для Android'))
snippet.write_text((source / 'nginx.conf').read_text().replace('/var/www/leader-product-download', str(root)))
try:
    if include not in content: site.write_text(content.replace(anchor, anchor + '\n    ' + include))
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print('Dev-only permanent download page installed; backup:', backup)
except BaseException:
    shutil.copy2(backup / site.name, site)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    raise
