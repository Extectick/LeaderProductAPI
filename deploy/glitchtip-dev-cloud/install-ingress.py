"""Change ONLY dev ingestion, with reversible configuration backup."""
import datetime
import json
import shutil
import subprocess
from pathlib import Path

site = Path('/etc/nginx/sites-available/dev.leader-product.ru')
snippet = Path('/etc/nginx/snippets/leader-crash-dev-cloud.conf')
seed = json.loads((Path(__file__).parent / 'private/seed.json').read_text())
assert seed['project'] == 'leader-app-dev'
project = int(seed['projectId'])
text = site.read_text()
old = 'include /opt/leader-api-dev/deploy/sentry-dev/nginx-ingest.conf;'
new = 'include /etc/nginx/snippets/leader-crash-dev-cloud.conf;'
assert old in text or new in text
backup = Path('/var/backups/leader-crash-dev-cloud') / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup.mkdir(parents=True)
shutil.copy2(site, backup / site.name)
if snippet.exists(): shutil.copy2(snippet, backup / snippet.name)
try:
    snippet.write_text(f'''# Private UI/admin API is never exposed.
location ~ ^/sentry/api/{project}/(envelope|store|minidump)/$ {{
    limit_req zone=leader_sentry_dev burst=30 nodelay;
    limit_req_status 429;
    limit_except POST OPTIONS {{ deny all; }}
    client_max_body_size 10m;
    access_log off;
    rewrite ^/sentry/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:19002;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Real-IP "";
    proxy_connect_timeout 3s;
    proxy_read_timeout 20s;
}}
location /sentry/ {{ return 404; }}
''')
    site.write_text(text.replace(old, new))
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print('Dev ingestion moved to private cloud backend. Backup:', backup)
except BaseException:
    shutil.copy2(backup / site.name, site)
    if (backup / snippet.name).exists(): shutil.copy2(backup / snippet.name, snippet)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    raise
