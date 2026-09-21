"""Cloud preparation; run only against the explicit dev checkout. No secret output."""
import os
import re
from pathlib import Path
from shutil import copy2

root = Path('/opt/leader-api-dev')
env = root / '.env'
if not env.is_file():
    raise SystemExit('Dev env not found')
backup = root / '.env.before-sentry-20260921'
if not backup.exists():
    copy2(env, backup)
    os.chmod(backup, 0o600)
content = env.read_text()
for name, value in {'DB_ACCEPT_DATA_LOSS': '0', 'APP_CRASH_REPORTING_ENABLED': 'false'}.items():
    line = f'{name}={value}'
    if re.search(rf'^{name}=.*$', content, re.M):
        content = re.sub(rf'^{name}=.*$', line, content, flags=re.M)
    else:
        content += '\n' + line + '\n'
env.write_text(content)
os.chmod(env, 0o600)
print('Dev DB data-loss acceptance disabled; crash feature remains off until configured')
