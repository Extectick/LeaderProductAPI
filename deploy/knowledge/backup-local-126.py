#!/usr/bin/env python3
"""Consistent private local snapshot including documents, Nextcloud metadata and dev DB."""
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
import subprocess

from local_126 import ROOT, COMPOSE, env_file, occ, run


def archive(args, target):
    with target.open('xb') as output:
        result = subprocess.run(args, stdout=output, stderr=subprocess.PIPE, timeout=600)
    if result.returncode:
        raise RuntimeError('Backup failed; private command output suppressed')


def readable_dump(args, source):
    with source.open('rb') as data:
        result = subprocess.run(args, stdin=data, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, timeout=120)
    if result.returncode:
        raise RuntimeError('Database archive verification failed')


def main():
    os.umask(0o077)
    (ROOT / 'runtime').mkdir(mode=0o700, exist_ok=True)
    with (ROOT / 'runtime/backup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        status = json.loads(occ('status', '--output=json'))
        if status['maintenance']:
            raise RuntimeError('Already in maintenance; backup will not change that state')
        target = ROOT / 'backups' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target.mkdir(parents=True, mode=0o700)
        running = run(COMPOSE + ['ps', '--services', '--status', 'running']).splitlines()
        paused_cron = False
        maintenance = False
        stopped_s3 = False
        try:
            if 'cron' in running:
                run(COMPOSE + ['stop', 'cron'])
                paused_cron = True
            occ('maintenance:mode', '--on')
            maintenance = True
            archive(COMPOSE + ['exec', '-T', 'database', 'pg_dump', '-U', 'nextcloud',
                               '-d', 'nextcloud', '-Fc'], target / 'nextcloud.dump')
            for destination, filename, parts in [('/var/www/html', 'nextcloud-files.tar.gz',
                                                  ['config', 'data', 'custom_apps', 'themes']),
                                                 ('/srv/knowledge', 'documents.tar.gz', ['.'])]:
                archive(COMPOSE + ['exec', '-T', '-u', 'root', 'nextcloud', 'tar', '-czf', '-',
                                   '-C', destination, *parts], target / filename)
            if env_file(ROOT / '.env').get('KNOWLEDGE_STORAGE') == 's3':
                cid = run(COMPOSE + ['ps', '-q', 'knowledge-s3']).strip()
                s3 = json.loads(run(['docker', 'inspect', cid]))[0]
                volume = next(m['Name'] for m in s3['Mounts'] if m['Destination'] == '/data' and m['Type'] == 'volume')
                app_cid = run(COMPOSE + ['ps', '-q', 'nextcloud']).strip()
                image = json.loads(run(['docker', 'inspect', app_cid]))[0]['Config']['Image']
                run(COMPOSE + ['stop', 'knowledge-s3'])
                stopped_s3 = True
                archive(['docker', 'run', '--rm', '--network', 'none', '--user', '0',
                         '--mount', 'type=volume,src=' + volume + ',dst=/data,readonly',
                         '--entrypoint', 'tar', image, '-czf', '-', '-C', '/data', '.'], target / 's3-data.tar.gz')
            archive(['tar', '-czf', '-', '--exclude=./backups', '--exclude=./runtime',
                     '-C', str(ROOT), '.'], target / 'deployment-private.tar.gz')
            pg = json.loads(run(['docker', 'inspect', 'leader_postgres_dev']))[0]
            pg_env = dict(item.split('=', 1) for item in pg['Config']['Env'])
            archive(['docker', 'exec', 'leader_postgres_dev', 'pg_dump', '-U', pg_env['POSTGRES_USER'],
                     '-d', 'LeaderAPI_dev', '-Fc'], target / 'LeaderAPI_dev.dump')
            readable_dump(COMPOSE + ['exec', '-T', 'database', 'pg_restore', '--list'], target / 'nextcloud.dump')
            readable_dump(['docker', 'exec', '-i', 'leader_postgres_dev', 'pg_restore', '--list'], target / 'LeaderAPI_dev.dump')
            for filename in ['nextcloud-files.tar.gz', 'documents.tar.gz', 'deployment-private.tar.gz',
                             *(['s3-data.tar.gz'] if stopped_s3 else [])]:
                run(['tar', '-tzf', str(target / filename)])
            hashes = {}
            for file in target.iterdir():
                digest = hashlib.sha256()
                with file.open('rb') as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(chunk)
                hashes[file.name] = digest.hexdigest()
            manifest = {'createdUtc': target.name, 'nextcloud': status['versionstring'],
                        'documentsIncluded': True, 'devDatabaseIncluded': True,
                        'primaryStorage': 'local-s3' if stopped_s3 else 'local-volume',
                        'archivesReadable': True, 'sha256': hashes, 'externalCopyConfigured': False}
            (target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        finally:
            try:
                if stopped_s3:
                    run(COMPOSE + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'knowledge-s3'])
                if maintenance:
                    occ('maintenance:mode', '--off')
            finally:
                if paused_cron:
                    run(COMPOSE + ['start', 'cron'])
        print(json.dumps({'snapshot': str(target), 'archivesReadable': True, 'externalCopyConfigured': False}))


if __name__ == '__main__':
    main()
