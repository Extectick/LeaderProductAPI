#!/usr/bin/env python3
"""Image-only release on docker-01. Keep Compose, secrets, queues and volumes intact."""
import argparse
import copy
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlparse
try:
    import fcntl
except ImportError:
    fcntl = None


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode:
        # Never expose resolved Compose, database credentials, or HTTP bodies.
        raise RuntimeError('Command failed: ' + ' '.join(map(str, args[:2])))
    return result.stdout.decode().strip()


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def private_json(path, value):
    temp = path.with_suffix('.tmp')
    with temp.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
    temp.chmod(0o600)
    temp.replace(path)


def environment(container):
    return dict(item.split('=', 1) for item in container['Config']['Env'])


def validate_target(target, env):
    expected = 'LeaderAPI_dev' if target == 'dev' else 'LeaderAPI'
    db = urlparse(env['DATABASE_URL'])
    if db.path != '/' + expected:
        raise RuntimeError('Wrong database for release target')
    if str(env.get('DB_ACCEPT_DATA_LOSS')) != '0':
        raise RuntimeError('Data-loss protection must be enabled')
    expected_mode = 'development' if target == 'dev' else 'production'
    if env.get('NODE_ENV') != expected_mode:
        raise RuntimeError('Wrong application environment')
    return expected


def healthy(container):
    for _ in range(60):
        state = inspect(container)['State']
        if state.get('Health', {}).get('Status') == 'healthy':
            result = json.loads(run(['docker', 'exec', container, 'node', '-e',
                'fetch("http://127.0.0.1:3000/health").then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))']))
            if result.get('ok') and all(x.get('ok') for x in result.get('services', {}).values()):
                return
        time.sleep(2)
    raise RuntimeError('API health check failed')


def release_services(target, assistant_bound):
    return ['api', 'help-assistant-worker'] if target == 'dev' and assistant_bound else ['api']


def help_binding_files(target, root):
    # Later provider bindings override earlier ones; keep prior files for rollback.
    if target != 'dev':
        return []
    return [root / name for name in ['help-bunny.private.json', 'help-t3.private.json', 'help-openai.private.json']
            if (root / name).exists()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', choices=['dev', 'prod'], required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--plan', action='store_true')
    args = parser.parse_args()
    if fcntl is None:
        raise RuntimeError('Deployment requires Linux')
    if not re.fullmatch('[0-9a-f]{40}', args.sha):
        raise RuntimeError('Immutable commit SHA required')
    if run(['hostname']) != 'docker-01':
        raise RuntimeError('Unexpected deployment host')
    os.umask(0o077)
    root = Path('/opt/leader-api-' + args.target)
    container = 'leader_api_' + args.target
    with (root / 'deployment.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        api = inspect(container)
        env = environment(api)
        database = validate_target(args.target, env)
        labels = api['Config']['Labels']
        if labels['com.docker.compose.project'] != 'leader-api-' + args.target:
            raise RuntimeError('Unexpected Compose project')
        live_files = list(dict.fromkeys(labels['com.docker.compose.project.config_files'].split(',')))
        if any(not Path(f).resolve().is_relative_to(root) for f in live_files):
            raise RuntimeError('Compose files outside target workspace')
        # Keep api.env authoritative. A resolved secret snapshot is only a backup,
        # not the next deployment's source of truth.
        files = [str(root / 'compose.yml')]
        if args.target == 'prod':
            files.append(str(root / 'compose.s3.yml'))
        bindings = help_binding_files(args.target, root)
        files.extend(map(str, bindings))
        overlay = root / 'release-image.json'
        previous_overlay = overlay.read_bytes() if overlay.exists() else None
        if previous_overlay is not None:
            files.append(str(overlay))
        command = ['docker', 'compose', '--profile', '*', '--project-name', 'leader-api-' + args.target,
                   '--project-directory', str(root)]
        for file in files:
            command += ['-f', file]
        original = json.loads(run(command + ['config', '--format', 'json']))
        service = original['services']['api']
        if any(str(value) != env.get(key) for key, value in service['environment'].items()):
            raise RuntimeError('Environment changed since API startup')
        # The first release after migration may still run from an older private
        # Compose snapshot. Roll back to the actual running image, never to the
        # bootstrap image pinned in the base file.
        service['image'] = api['Config']['Image']
        if env.get('DB_INIT_MODE'):
            service['environment']['DB_INIT_MODE'] = env['DB_INIT_MODE']
        services = release_services(args.target, bool(bindings))
        excluded = ['/' + container] + (['/leader_help_assistant_dev'] if len(services) > 1 else [])
        protected = {x['Name']: x['Id'] for x in json.loads(run(['docker', 'inspect'] +
            run(['docker', 'ps', '-q']).splitlines())) if x['Name'] not in excluded}
        image = 'ghcr.io/extectick/leaderproductapi:' + args.sha
        print(json.dumps({'plan': True, 'target': args.target, 'database': database,
                          'image': image, 'services': services, 'preserveConfiguration': True}), flush=True)
        if args.plan:
            return
        run(['docker', 'pull', image], timeout=600)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        state = root / 'deploy-state' / (stamp + '-' + args.sha[:12])
        state.mkdir(parents=True, mode=0o700)
        private_json(state / 'previous-compose.private.json', original)
        pg_name = 'leader_postgres_' + args.target
        pg_user = environment(inspect(pg_name))['POSTGRES_USER']
        dump_path = state / (database + '.dump')
        with dump_path.open('wb') as stream:
            subprocess.run(['docker', 'exec', pg_name, 'pg_dump', '-U', pg_user,
                            '-d', database, '-Fc'], stdout=stream, check=True)
        with dump_path.open('rb') as stream:
            subprocess.run(['docker', 'exec', '-i', pg_name, 'pg_restore', '--list'],
                           stdin=stream, stdout=subprocess.DEVNULL, check=True)
        updated = copy.deepcopy(original)
        for name in services:
            updated['services'][name]['image'] = image
            updated['services'][name].pop('build', None)
            updated['services'][name]['pull_policy'] = 'never'
        updated['services']['api'].pop('build', None)
        updated['services']['api']['pull_policy'] = 'never'
        updated['services']['api']['environment']['DB_INIT_MODE'] = 'verify'
        private_json(state / 'compose.private.json', updated)
        image_services = {name: {'image': image, 'pull_policy': 'never'} for name in services}
        image_services['api']['environment'] = {'DB_INIT_MODE': 'verify'}
        private_json(overlay, {'services': image_services})
        release_command = ['docker', 'compose', '--project-name', 'leader-api-' + args.target,
            '--project-directory', str(root)]
        for file in list(dict.fromkeys(files + [str(overlay)])):
            release_command += ['-f', file]
        try:
            run(release_command + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never'] + services, timeout=300)
            healthy(container)
            if 'help-assistant-worker' in services:
                worker = inspect('leader_help_assistant_dev')
                if worker['Config']['Image'] != image or not worker['State']['Running']:
                    raise RuntimeError('Dev assistant worker did not start')
            if inspect(container)['Config']['Image'] != image:
                raise RuntimeError('Unexpected running image')
            if any(inspect(name)['Id'] != identity for name, identity in protected.items()):
                raise RuntimeError('Unrelated container changed during release')
        except Exception:
            if previous_overlay is None:
                overlay.unlink(missing_ok=True)
            else:
                temp = overlay.with_suffix('.tmp')
                temp.write_bytes(previous_overlay)
                temp.chmod(0o600)
                temp.replace(overlay)
            rollback = ['docker', 'compose', '--project-name', 'leader-api-' + args.target,
                '--project-directory', str(root), '-f', str(state / 'previous-compose.private.json')]
            run(rollback + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never'] + services, timeout=300)
            healthy(container)
            raise
        (root / 'current-deployment.txt').write_text(str(state) + '\n')
        print(json.dumps({'deployed': args.sha, 'target': args.target,
                          'backup': str(dump_path), 'unrelatedContainersUnchanged': True}), flush=True)


if __name__ == '__main__':
    main()
