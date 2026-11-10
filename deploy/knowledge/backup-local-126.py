#!/usr/bin/env python3
"""Consistent private local snapshot including documents, Nextcloud metadata and dev DB."""
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
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


def api_config_files(api_root):
    """Capture the actual dev bindings, not a historical fixed list of providers."""
    names = {name for name in ['compose.yml', '.env', 'api.env', 'release-image.json',
                              'knowledge-source.env', 'knowledge-indexer.env', 'secrets']
             if (api_root / name).exists()}
    names.update(path.name for path in api_root.glob('*.private.json') if path.is_file())
    for container in json.loads(run(['docker', 'inspect', 'leader_api_dev', 'leader_help_assistant_dev'])):
        env = dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)
        from urllib.parse import urlsplit
        if env.get('NODE_ENV') != 'development' or urlsplit(env.get('DATABASE_URL', '')).path != '/LeaderAPI_dev':
            raise RuntimeError('Refusing non-dev recovery configuration')
        for filename in container['Config']['Labels']['com.docker.compose.project.config_files'].split(','):
            path = Path(filename)
            if not path.is_relative_to(api_root) or not path.is_file():
                raise RuntimeError('Unexpected dev Compose configuration location')
            names.add(str(path.relative_to(api_root)))
        for mount in container['Mounts']:
            source = Path(mount['Source'])
            if mount['Type'] == 'bind' and source.is_relative_to(api_root):
                relative = source.relative_to(api_root)
                # The complete root-owned secrets tree is already included; do
                # not stat its children using the unprivileged scheduler account.
                if relative.parts and relative.parts[0] == 'secrets':
                    continue
                if source.is_file():
                    names.add(str(relative))
    return sorted(names)


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
            # pg_dump does not include LOGIN roles/password hashes. Nextcloud may
            # use its generated oc_admin role rather than the bootstrap superuser.
            archive(COMPOSE + ['exec', '-T', 'database', 'pg_dumpall', '-U', 'nextcloud',
                               '--globals-only'], target / 'nextcloud-roles.sql')
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
            api_root = Path('/opt/leader-api-dev')
            api_files = api_config_files(api_root)
            # Runtime env/secret files are intentionally root-owned. Read them in a
            # network-isolated helper through a read-only mount; never relax permissions.
            app_cid = run(COMPOSE + ['ps', '-q', 'nextcloud']).strip()
            image = json.loads(run(['docker', 'inspect', app_cid]))[0]['Config']['Image']
            archive(['docker', 'run', '--rm', '--network', 'none', '--user', '0',
                     '--mount', 'type=bind,src=' + str(api_root) + ',dst=/recovery,readonly',
                     '--entrypoint', 'tar', image, '-czf', '-', '-C', '/recovery', *api_files],
                    target / 'api-config-private.tar.gz')
            pg = json.loads(run(['docker', 'inspect', 'leader_postgres_dev']))[0]
            pg_env = dict(item.split('=', 1) for item in pg['Config']['Env'])
            archive(['docker', 'exec', 'leader_postgres_dev', 'pg_dump', '-U', pg_env['POSTGRES_USER'],
                     '-d', 'LeaderAPI_dev', '-Fc'], target / 'LeaderAPI_dev.dump')
            archive(['docker', 'exec', 'leader_postgres_dev', 'pg_dumpall', '-U', pg_env['POSTGRES_USER'],
                     '--globals-only'], target / 'LeaderAPI_dev-roles.sql')
            readable_dump(COMPOSE + ['exec', '-T', 'database', 'pg_restore', '--list'], target / 'nextcloud.dump')
            readable_dump(['docker', 'exec', '-i', 'leader_postgres_dev', 'pg_restore', '--list'], target / 'LeaderAPI_dev.dump')
            for filename in ['nextcloud-files.tar.gz', 'documents.tar.gz', 'deployment-private.tar.gz', 'api-config-private.tar.gz',
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
            manifest['apiConfigurationFiles'] = api_files
            manifest['postgresRolesIncluded'] = True
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
