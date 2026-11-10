#!/usr/bin/env python3
"""Persist the local source in dev Compose; preserve the currently selected AI provider."""
import copy
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit

from local_126 import ROOT, env_file, private_write, run


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def environment(container):
    return dict(item.split('=', 1) for item in container['Config']['Env'])


def main():
    os.umask(0o077)
    if run(['hostname']).strip() != 'docker-01' or ROOT != Path('/opt/leader-knowledge-126'):
        raise RuntimeError('Unexpected host or deployment directory')
    root = Path('/opt/leader-api-dev')
    with (root / 'deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        api = inspect('leader_api_dev')
        live = environment(api)
        if (urlsplit(live['DATABASE_URL']).path != '/LeaderAPI_dev' or live.get('NODE_ENV') != 'development'
                or live.get('DB_ACCEPT_DATA_LOSS') != '0'
                or api['Config']['Labels'].get('com.docker.compose.project') != 'leader-api-dev'):
            raise RuntimeError('Unexpected dev target; deployment refused')
        if live.get('NODE_EXTRA_CA_CERTS') not in (None, '', '/run/knowledge-126-ca.crt'):
            raise RuntimeError('Existing extra CA bundle needs explicit merging')
        source = env_file(ROOT / '.env.knowledge.worker')
        if source.get('KNOWLEDGE_SOURCE_KEY') != 'company-126-dev' or source.get('KNOWLEDGE_NEXTCLOUD_URL') != 'https://192.168.30.126:18443':
            raise RuntimeError('Unexpected knowledge source')
        # The certificate is public; API containers run as a different UID.
        (ROOT / 'secrets/tls/ca.crt').chmod(0o444)
        files = [root / 'compose.yml']
        for name in ['help-bunny.private.json', 'release-image.json']:
            if (root / name).exists():
                files.append(root / name)
        command = ['docker', 'compose', '--profile', '*', '-p', 'leader-api-dev', '--project-directory', str(root)]
        for file in files:
            command += ['-f', str(file)]
        original = json.loads(run(command + ['config', '--format', 'json']))
        resolved = original['services']['api']
        if any(str(value) != live.get(key) for key, value in resolved['environment'].items()):
            raise RuntimeError('Live configuration drift; deployment refused')
        running = run(['docker', 'ps', '-q']).split()
        protected = {row['Name']: row['Id'] for row in json.loads(run(['docker', 'inspect', *running]))
                     if row['Name'] not in ['/leader_api_dev', '/leader_help_assistant_dev', '/leader_knowledge_worker_dev']}
        state = ROOT / 'runtime' / ('binding-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        state.mkdir(mode=0o700)
        previous = (root / 'compose.yml').read_bytes()
        (state / 'compose.before.private.json').write_bytes(previous)
        private_write(state / 'resolved.before.private.json', json.dumps(original, indent=2) + '\n')
        source['NODE_EXTRA_CA_CERTS'] = '/run/knowledge-126-ca.crt'
        content = ''.join(key + '=' + value + '\n' for key, value in source.items())
        source_file = root / 'knowledge-source.env'
        indexer_file = root / 'knowledge-indexer.env'
        previous_envs = {p: p.read_bytes() if p.exists() else None for p in [source_file, indexer_file]}
        for p, value in previous_envs.items():
            if value is not None:
                (state / (p.name + '.before.private')).write_bytes(value)
        private_write(source_file, content)
        private_write(indexer_file, content + 'DATABASE_URL=' + live['DATABASE_URL'] + '\nNODE_ENV=production\n')
        updated = json.loads(previous)
        ca = {'type': 'bind', 'source': str(ROOT / 'secrets/tls/ca.crt'),
              'target': '/run/knowledge-126-ca.crt', 'read_only': True}
        for name in ['api', 'help-assistant-worker']:
            service = updated['services'][name]
            envs = service.setdefault('env_file', [])
            if 'knowledge-source.env' not in envs:
                envs.append('knowledge-source.env')
            volumes = service.setdefault('volumes', [])
            if not any(isinstance(v, dict) and v.get('target') == ca['target'] or
                       isinstance(v, str) and ':' + ca['target'] in v for v in volumes):
                volumes.append(ca)
        updated['services']['knowledge-worker'] = {
            'image': api['Config']['Image'], 'pull_policy': 'never', 'container_name': 'leader_knowledge_worker_dev',
            'restart': 'unless-stopped', 'init': True, 'command': ['node', 'dist/workers/knowledgeWorker.js'],
            'env_file': ['knowledge-indexer.env'], 'environment': {'NODE_OPTIONS': '--max-old-space-size=192'},
            'networks': ['default'], 'volumes': [ca], 'mem_limit': '512m', 'cpus': 0.50, 'pids_limit': 64,
            'read_only': True, 'tmpfs': ['/tmp:size=64m,mode=1777'], 'cap_drop': ['ALL'],
            'security_opt': ['no-new-privileges:true'], 'stop_grace_period': '90s',
            'healthcheck': {'test': ['CMD', 'node', 'scripts/knowledge-worker-health.cjs'],
                            'start_period': '120s', 'interval': '30s', 'timeout': '5s', 'retries': 3}}
        private_write(root / 'compose.yml', json.dumps(updated, indent=2) + '\n')
        try:
            run(command + ['config', '--quiet'])
            run(command + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                           'api', 'help-assistant-worker', 'knowledge-worker'], timeout=300)
            for _ in range(60):
                if inspect('leader_api_dev')['State'].get('Health', {}).get('Status') == 'healthy':
                    break
                time.sleep(1)
            else:
                raise RuntimeError('Dev API did not become healthy')
            for name in ['leader_api_dev', 'leader_help_assistant_dev', 'leader_knowledge_worker_dev']:
                obj = inspect(name)
                flags = environment(obj)
                if not obj['State']['Running'] or flags.get('KNOWLEDGE_ENABLED') != 'true' or flags.get('KNOWLEDGE_SOURCE_KEY') != source['KNOWLEDGE_SOURCE_KEY']:
                    raise RuntimeError('Knowledge configuration not applied')
                if name != 'leader_knowledge_worker_dev' and flags.get('HELP_AI_PROVIDER') != live.get('HELP_AI_PROVIDER'):
                    raise RuntimeError('AI provider unexpectedly changed')
            if any(inspect(name)['Id'] != identity for name, identity in protected.items()):
                raise RuntimeError('Unrelated container changed')
        except Exception:
            (root / 'compose.yml').write_bytes(previous)
            (root / 'compose.yml').chmod(0o600)
            for p, value in previous_envs.items():
                if value is None:
                    p.unlink(missing_ok=True)
                else:
                    p.write_bytes(value)
                    p.chmod(0o600)
            if 'knowledge-worker' not in original['services']:
                subprocess.run(['docker', 'stop', 'leader_knowledge_worker_dev'], capture_output=True)
                subprocess.run(['docker', 'rm', 'leader_knowledge_worker_dev'], capture_output=True)
            rollback = ['docker', 'compose', '-p', 'leader-api-dev', '--project-directory', str(root),
                        '-f', str(state / 'resolved.before.private.json')]
            run(rollback + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', 'help-assistant-worker'], timeout=300)
            raise
        private_write(state / 'result.json', json.dumps({'bound': True, 'source': source['KNOWLEDGE_SOURCE_KEY'],
                      'assistantProviderPreserved': live.get('HELP_AI_PROVIDER'), 'unrelatedContainersUnchanged': True}) + '\n')
        print((state / 'result.json').read_text().strip())


if __name__ == '__main__':
    main()
