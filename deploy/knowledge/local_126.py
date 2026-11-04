"""Shared, output-sanitized commands for the separate knowledge deployment on 126."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
COMPOSE = ['docker', 'compose', '-p', 'leader-knowledge-126', '--project-directory', str(ROOT),
           '-f', str(ROOT / 'compose.yml'), '-f', str(ROOT / 'compose.local-126.yml')]
if (ROOT / 'compose.s3-126.yml').exists():
    COMPOSE += ['-f', str(ROOT / 'compose.s3-126.yml')]


def run(args, *, payload=None, timeout=180, env=None):
    result = subprocess.run(args, input=payload, capture_output=True, text=True,
                            timeout=timeout, env=env)
    if result.returncode:
        # Docker/occ errors can include private configuration; don't publish them.
        raise RuntimeError('Deployment command failed; private output suppressed')
    return result.stdout


def occ(*args, payload=None, password=None):
    import os
    env = dict(os.environ)
    command = COMPOSE + ['exec', '-T', '-u', 'www-data']
    if password is not None:
        env['OC_PASS'] = password
        command += ['-e', 'OC_PASS']
    return run(command + ['nextcloud', 'php', 'occ', '--no-warnings', *args],
               payload=payload, env=env)


def env_file(path):
    result = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            result[key.strip()] = value.strip().strip('\"').strip("'")
    return result


def private_write(path, content):
    if path.is_symlink():
        raise RuntimeError('Refusing a symlink for a private file')
    with path.open('w', encoding='utf-8') as target:
        target.write(content)
    path.chmod(0o600)


def volume_path(destination):
    cid = run(COMPOSE + ['ps', '-q', 'nextcloud']).strip()
    if not cid:
        raise RuntimeError('New Nextcloud is not running')
    info = json.loads(run(['docker', 'inspect', cid]))[0]
    if info['Config']['Labels'].get('com.docker.compose.project') != 'leader-knowledge-126':
        raise RuntimeError('Unexpected Compose project')
    mount = next(item for item in info['Mounts'] if item['Destination'] == destination)
    if mount['Type'] != 'volume':
        raise RuntimeError('Expected a managed persistent volume')
    return mount['Source']
