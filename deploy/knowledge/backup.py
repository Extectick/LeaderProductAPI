#!/usr/bin/env python3
"""Private consistent Nextcloud metadata snapshot. External S3 contents are separate."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
compose = ['docker', 'compose', '--project-directory', str(root)]
occ = compose + ['exec', '-T', '-u', 'www-data', 'nextcloud', 'php', 'occ', '--no-warnings']


def run(args, **kwargs):
    result = subprocess.run(args, stderr=subprocess.PIPE, timeout=180, **kwargs)
    if result.returncode:
        raise RuntimeError('Backup step failed; secret-bearing command output suppressed')
    return result


def main():
    os.umask(0o077)
    target = root / 'backups' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target.mkdir(parents=True, mode=0o700)
    cid = run(compose + ['ps', '-q', 'nextcloud'], stdout=subprocess.PIPE, text=True).stdout.strip()
    info = json.loads(run(['docker', 'inspect', cid], stdout=subprocess.PIPE, text=True).stdout)[0]
    volume = next(m['Source'] for m in info['Mounts'] if m['Destination'] == '/var/www/html')
    status = json.loads(run(occ + ['status', '--output=json'], stdout=subprocess.PIPE, text=True).stdout)
    if status['maintenance']:
        raise RuntimeError('Already in maintenance; backup will not change this state')
    running = run(compose + ['ps', '--services', '--status', 'running'], stdout=subprocess.PIPE, text=True).stdout.splitlines()
    paused_cron = False
    maintenance = False
    try:
        if 'cron' in running:
            run(compose + ['stop', 'cron'], stdout=subprocess.DEVNULL)
            paused_cron = True
        run(occ + ['maintenance:mode', '--on'], stdout=subprocess.DEVNULL)
        maintenance = True
        with (target / 'database.dump').open('xb') as output:
            run(compose + ['exec', '-T', 'database', 'pg_dump', '-U', 'nextcloud', '-d', 'nextcloud', '-Fc'], stdout=output)
        run(['tar', '-czf', str(target / 'files.tar.gz'), '-C', volume,
             'config', 'data', 'custom_apps', 'themes'], stdout=subprocess.DEVNULL)
        run(['tar', '-czf', str(target / 'deployment-private.tar.gz'), '-C', str(root),
             '.env', 'secrets', 'compose.yml', 'apache-workers.conf', 'folders.json'], stdout=subprocess.DEVNULL)
        with (target / 'database.dump').open('rb') as source:
            run(compose + ['exec', '-T', 'database', 'pg_restore', '--list'], stdin=source, stdout=subprocess.DEVNULL)
        for archive in ('files.tar.gz', 'deployment-private.tar.gz'):
            run(['tar', '-tzf', str(target / archive)], stdout=subprocess.DEVNULL)
        (target / 'manifest.json').write_text(json.dumps({
            'nextcloud': status['versionstring'], 'createdUtc': target.name,
            'databaseArchiveReadable': True, 'fileArchivesReadable': True,
            'externalS3Included': False, 'restoreRehearsalCompleted': False,
        }, indent=2) + '\n')
    finally:
        try:
            if maintenance:
                run(occ + ['maintenance:mode', '--off'], stdout=subprocess.DEVNULL)
        finally:
            if paused_cron:
                run(compose + ['start', 'cron'], stdout=subprocess.DEVNULL)
    print(json.dumps({'snapshot': str(target), 'externalS3Included': False}))


if __name__ == '__main__':
    main()
