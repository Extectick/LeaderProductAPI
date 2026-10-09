"""Use the existing dev S3 account, strictly under a new diagnostics prefix."""
from pathlib import Path
import os

def read_env(path):
    result = {}
    for line in path.read_text().splitlines():
        if '=' not in line or line.strip().startswith('#'): continue
        key, value = line.split('=', 1)
        result[key.strip()] = value.strip().strip('"\'')
    return result

source = read_env(Path('/opt/leader-api-dev/.env'))
target = Path(__file__).parent / 'private/app.env'
values = {
    'AWS_ACCESS_KEY_ID': source['S3_ACCESS_KEY'],
    'AWS_SECRET_ACCESS_KEY': source['S3_SECRET_KEY'],
    'AWS_STORAGE_BUCKET_NAME': source['S3_BUCKET'],
    'AWS_S3_ENDPOINT_URL': source['S3_ENDPOINT'],
    'AWS_LOCATION': 'dev/diagnostics/storage',
}
assert values['AWS_S3_ENDPOINT_URL'].startswith('https://')
assert all(values.values())
lines = [line for line in target.read_text().splitlines() if line.split('=', 1)[0] not in values]
target.write_text('\n'.join(lines + [f'{key}={value}' for key, value in values.items()]) + '\n')
os.chmod(target, 0o600)
print('Dev diagnostic artifacts configured in private dev/diagnostics/storage prefix; credentials hidden.')
