#!/usr/bin/env python3
"""DEV-only release: retain the effective configuration of API and active workers.

Resolved Compose files contain secrets. Keep them root-only outside Git, never log
their contents, and never reintroduce simulator defaults over an active provider.
"""
import argparse
import copy
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlparse

ROOT = Path('/opt/leader-api-dev')

def run(args, **kw):
    result = subprocess.run(args, capture_output=True, text=True, **kw)
    if result.returncode:
        # Compose diagnostics may include interpolated configuration/credentials.
        raise RuntimeError('Command failed: ' + ' '.join(args[:2]))
    return result.stdout.strip()

def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]

def config_files(container):
    labels = container['Config']['Labels']
    if labels['com.docker.compose.project'] != 'leader-api-dev':
        raise RuntimeError('Unexpected Compose project')
    files = labels['com.docker.compose.project.config_files'].split(',')
    if any(not Path(f).resolve().is_relative_to(ROOT) for f in files):
        raise RuntimeError('Compose file outside DEV workspace')
    return files, labels['com.docker.compose.project.working_dir']

def command(files, directory):
    args = ['docker', 'compose', '--profile', '*', '--project-name', 'leader-api-dev', '--project-directory', directory]
    for file in files:
        args += ['-f', str(file)]
    return args

def private_json(path, value):
    with path.open('x', encoding='utf-8') as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
    path.chmod(0o600)

def healthy():
    for _ in range(45):
        state = inspect('leader_api_dev')['State']
        if state.get('Health', {}).get('Status') == 'healthy':
            if run(['curl', '--fail', '--silent', '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:3001/health']) == '200':
                return
        time.sleep(2)
    raise RuntimeError('DEV API health timeout')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sha', required=True)
    parser.add_argument('--plan', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}', args.sha):
        raise RuntimeError('Expected immutable commit SHA')
    os.umask(0o077)
    with (ROOT / 'deployment.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        api = inspect('leader_api_dev')
        prod = {name: inspect(name)['Id'] for name in ['leader_api', 'leader_app']}
        vpn = run(['systemctl', 'is-active', 'openvpn-client@leader-nsk'])
        files, directory = config_files(api)
        original = json.loads(run(command(files, directory) + ['config', '--format', 'json']))
        services = ['api']
        live = {'api': api}
        for name in ['leader_help_assistant_dev', 'leader_knowledge_worker_dev']:
            if subprocess.run(['docker', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                container = inspect(name)
                service = container['Config']['Labels']['com.docker.compose.service']
                if container['State']['Running']:
                    if service not in original['services']:
                        raise RuntimeError('Active worker missing from effective Compose config')
                    services.append(service)
                    live[service] = container
        for service in services:
            conf = original['services'][service]
            env = conf['environment']
            current = dict(item.split('=', 1) for item in live[service]['Config']['Env'])
            db = urlparse(env['DATABASE_URL'])
            if db.hostname != 'postgres-dev' or db.path != '/LeaderAPI_dev':
                raise RuntimeError('Unexpected database target')
            # Fail before replacement if an operator changed files after startup.
            if any(str(value) != current.get(key) for key, value in env.items()):
                raise RuntimeError('Environment drift; reconcile running DEV configuration before deployment')
            if service == 'api':
                if env.get('NODE_ENV') != 'development' or str(env.get('DB_ACCEPT_DATA_LOSS')) != '0' or env.get('DB_INIT_MODE') != 'verify':
                    raise RuntimeError('Unsafe DEV startup configuration')
                if not conf.get('ports') or any(p.get('host_ip') != '127.0.0.1' for p in conf['ports']):
                    raise RuntimeError('Unexpected public API port')
            elif conf.get('ports'):
                raise RuntimeError('Worker must have no public ports')
        print(json.dumps({'plan': True, 'services': services, 'preserveEnvironmentCommandsMounts': True, 'database': 'LeaderAPI_dev'}), flush=True)
        if args.plan:
            return
        # An older queued workflow must never replace a newer published DEV head.
        run(['git', '-C', str(ROOT), 'fetch', 'origin', 'dev'])
        if run(['git', '-C', str(ROOT), 'rev-parse', 'origin/dev']) != args.sha:
            raise RuntimeError('DEV advanced; deploy the latest commit instead')
        image = 'ghcr.io/extectick/leaderproductapi:' + args.sha
        run(['docker', 'pull', image], timeout=600)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        state = ROOT / 'deploy-state' / (stamp + '-' + args.sha[:12])
        state.mkdir(parents=True, mode=0o700)
        private_json(state / 'previous-compose.private.json', original)
        private_json(state / 'previous-containers.private.json', list(live.values()))
        with (state / 'LeaderAPI_dev.dump').open('wb') as dump:
            subprocess.run(['docker', 'exec', 'leader_postgres_dev', 'pg_dump', '-U', 'postgres', '-d', 'LeaderAPI_dev', '-Fc'], stdout=dump, check=True)
        with (state / 'LeaderAPI_dev.dump').open('rb') as dump:
            subprocess.run(['docker', 'exec', '-i', 'leader_postgres_dev', 'pg_restore', '--list'], stdin=dump, stdout=subprocess.DEVNULL, check=True)
        updated = copy.deepcopy(original)
        for service in services:
            updated['services'][service]['image'] = image
            updated['services'][service].pop('build', None)
            updated['services'][service]['pull_policy'] = 'never'
        private_json(state / 'compose.private.json', updated)
        dc = command([state / 'compose.private.json'], str(ROOT))
        migrate = dc + ['run', '--rm', '--no-deps', '-e', 'DB_ACCEPT_DATA_LOSS=0', '-e', 'KNOWLEDGE_MIGRATION_TARGET=dev', '-e', 'KNOWLEDGE_MIGRATION_DATABASE_CONFIRM=LeaderAPI_dev', '-e', 'ONEC_MIGRATION_DATABASE_CONFIRM=LeaderAPI_dev', '--entrypoint', 'node', 'api']
        for script in ['apply-knowledge-migration.cjs', 'apply-onec-personal-migration.cjs', 'apply-onec-names-migration.cjs', 'verify-help-assistant-schema.cjs']:
            run(migrate + ['scripts/' + script], timeout=90)
        try:
            run(dc + ['up', '-d', '--no-deps', '--no-build'] + services, timeout=300)
            healthy()
            for service in services:
                current = inspect(original['services'][service]['container_name'])
                if not current['State']['Running'] or current['Config']['Image'] != image:
                    raise RuntimeError('DEV service did not start with reviewed image')
            if {name: inspect(name)['Id'] for name in prod} != prod:
                raise RuntimeError('Production identity changed during deployment')
            if run(['systemctl', 'is-active', 'openvpn-client@leader-nsk']) != vpn:
                raise RuntimeError('VPN state changed during deployment')
            run(['curl', '--fail', '--silent', '--max-time', '5', '-o', '/dev/null', 'http://127.0.0.1:3000/health'])
        except Exception:
            rollback = command([state / 'previous-compose.private.json'], str(ROOT))
            run(rollback + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never'] + services, timeout=300)
            healthy()
            raise
        (ROOT / 'current-dev-deployment.txt').write_text(str(state) + '\n', encoding='utf-8')
        print(json.dumps({'deployed': args.sha, 'services': services, 'backupAndRollback': str(state), 'productionUnchanged': True, 'vpnPreserved': True}), flush=True)

if __name__ == '__main__':
    main()
