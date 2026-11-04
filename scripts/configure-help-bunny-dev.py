#!/usr/bin/env python3
"""Bind the reviewed dev API and dedicated help worker; never migrate or touch prod."""
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import time
import subprocess

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('deploy-server-api.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


stage = 'initial'

def phase(name):
    global stage
    stage = name
    print('Bunny activation stage: ' + name, flush=True)

def probe(name, javascript, timeout=30):
    phase(name)
    result = subprocess.run(['docker', 'exec', name.split(':')[-1], 'node', '-e', javascript], capture_output=True, timeout=timeout)
    if result.returncode:
        code = 'PROBE_FAILED'
        for line in result.stdout.decode(errors='replace').splitlines():
            try:
                value = json.loads(line)
                candidate = value.get('errorCode', '')
                if re.fullmatch(r'[A-Z][A-Z0-9_]{0,100}', str(candidate)):
                    code = candidate
            except (ValueError, AttributeError):
                pass
        raise RuntimeError(name + ': ' + code)
    return result.stdout.decode(errors='replace').strip()

def main():
    os.umask(0o077)
    if r.run(['hostname']) != 'docker-01':
        raise RuntimeError('Unexpected host')
    sha = os.environ['RELEASE_SHA']
    key = os.environ['BUNNY_CHAT_API_KEY']
    if not re.fullmatch('[0-9a-f]{40}', sha) or not key or re.search(r'\s', key):
        raise RuntimeError('Missing dev release or key')
    # Activation helper/workflow changes can reuse the already reviewed image.
    # All image-affecting files must still match that image's exact source commit.
    r.run(['git', 'diff', '--exit-code', sha, 'HEAD', '--', 'src', 'prisma', 'prisma.config.js', 'package.json', 'package-lock.json', 'Dockerfile', '.dockerignore', 'tsconfig.json'])
    root = Path('/opt/leader-api-dev')
    with (root / 'deployment.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        phase('inspect-dev')
        api = r.inspect('leader_api_dev')
        r.validate_target('dev', r.environment(api))
        print(probe('network-diagnostics:leader_api_dev',
            'const dns=require("node:dns/promises");(async()=>{const addresses=await dns.lookup("ai.bunny.ge",{all:true}).catch(()=>[]);let network;try{const r=await fetch("https://ai.bunny.ge/api/v1/health",{signal:AbortSignal.timeout(10000),redirect:"error"});await r.body?.cancel();network={httpStatus:r.status}}catch(e){const c=e.cause||e;network={code:c.code||e.name,address:c.address,port:c.port,errors:c.errors?.map(x=>({code:x.code,address:x.address,port:x.port}))}}console.log(JSON.stringify({addresses,network,proxyConfigured:Boolean(process.env.HTTPS_PROXY||process.env.HTTP_PROXY),envProxyEnabled:process.env.NODE_USE_ENV_PROXY==="1"}))})()', timeout=15), flush=True)
        image = 'ghcr.io/extectick/leaderproductapi:' + sha
        if api['Config']['Image'] != image:
            raise RuntimeError('Deploy this exact SHA to dev first')
        files = [root / 'compose.yml']
        binding = root / 'help-bunny.private.json'
        previous = binding.read_bytes() if binding.exists() else None
        if previous is not None:
            files.append(binding)
        overlay = root / 'release-image.json'
        if overlay.exists():
            files.append(overlay)
        cmd = ['docker', 'compose', '--profile', '*', '-p', 'leader-api-dev', '--project-directory', str(root)]
        for f in files:
            cmd += ['-f', str(f)]
        config = json.loads(r.run(cmd + ['config', '--format', 'json']))
        old = copy.deepcopy(config)
        # Preserve a legacy worker deployed from an earlier Compose worktree.
        running_names = r.run(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()
        if 'leader_help_assistant_dev' in running_names and 'help-assistant-worker' not in old['services']:
            legacy = r.inspect('leader_help_assistant_dev')
            labels = legacy['Config']['Labels']
            if labels.get('com.docker.compose.project') != 'leader-api-dev':
                raise RuntimeError('Unexpected existing help worker project')
            paths = labels.get('com.docker.compose.project.config_files', '').split(',')
            if not paths or any(not Path(f).resolve().is_relative_to(root) for f in paths):
                raise RuntimeError('Cannot safely recover existing help worker configuration')
            legacy_cmd = ['docker', 'compose', '--profile', '*', '-p', 'leader-api-dev', '--project-directory', str(root)]
            for f in paths:
                legacy_cmd += ['-f', f]
            legacy_env = r.environment(legacy)
            legacy_config = json.loads(r.run(legacy_cmd + ['config', '--format', 'json'], env={**os.environ,
                'HELP_SIMULATOR_IMAGE': legacy['Config']['Image'],
                'HELP_AI_SIMULATOR_DURATION_MS': legacy_env.get('HELP_AI_SIMULATOR_DURATION_MS', '300000')}))
            old['services']['help-assistant-worker'] = legacy_config['services']['help-assistant-worker']
            old['services']['help-assistant-worker']['image'] = legacy['Config']['Image']
            old['services']['help-assistant-worker']['environment'] = legacy_env
            for kind in ['networks', 'volumes', 'secrets', 'configs']:
                for name, value in legacy_config.get(kind, {}).items():
                    old.setdefault(kind, {}).setdefault(name, value)
        api_config = config['services']['api']
        live_env = r.environment(api)
        if any(str(value) != live_env.get(name) for name, value in api_config['environment'].items()):
            raise RuntimeError('Configuration drift; deploy dev before activation')
        phase('verify-help-schema')
        r.run(['docker', 'exec', 'leader_api_dev', 'node', 'scripts/verify-help-assistant-schema.cjs'])
        env = {'HELP_AI_ENABLED': 'true', 'HELP_AI_PROVIDER': 'bunny', 'HELP_BUNNY_DEV_ENABLED': 'true', 'BUNNY_CHAT_API_KEY': key, 'BUNNY_CHAT_API_KEY_FILE': ''}
        worker_env = {**api_config['environment'], **env, 'DB_INIT_MODE': 'verify', 'DB_ACCEPT_DATA_LOSS': '0', 'DB_AUTO_SEED': '0'}
        worker = {'image': image, 'pull_policy': 'never', 'container_name': 'leader_help_assistant_dev', 'restart': 'unless-stopped',
                  'init': True, 'environment': worker_env, 'command': ['node', 'dist/workers/helpAssistantWorker.js'],
                  'networks': {name: None for name in api_config.get('networks', {'default': None})}, 'healthcheck': {'disable': True}, 'stop_grace_period': '130s'}
        data = {'services': {'api': {'environment': env}, 'help-assistant-worker': worker}}
        state = root / 'deploy-state' / ('bunny-' + sha[:12] + '-' + str(int(time.time())))
        state.mkdir(mode=0o700)
        r.private_json(state / 'previous-compose.private.json', old)
        protected = {x['Name']: x['Id'] for x in json.loads(r.run(['docker', 'inspect'] + r.run(['docker', 'ps', '-q']).splitlines()))
                     if x['Name'] not in ['/leader_api_dev', '/leader_help_assistant_dev']}
        phase('persist-private-binding')
        r.private_json(binding, data)
        # Binding goes after image overlay on first activation as well.
        next_cmd = cmd + ['-f', str(binding)]
        try:
            phase('start-dev-api-worker')
            r.run(next_cmd + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', 'help-assistant-worker'], timeout=300)
            phase('health-api')
            r.healthy('leader_api_dev')
            for name in ['leader_api_dev', 'leader_help_assistant_dev']:
                probe('config:' + name, 'try{const c=require("./dist/modules/help/help.assistant").helpAssistantConfiguration();if(!c.enabled||c.provider!=="bunny")throw {code:"BUNNY_NOT_ENABLED"};console.log("Bunny dev configured")}catch(e){console.log(JSON.stringify({errorCode:e.code||"MODULE_CONFIG_FAILED"}));process.exitCode=1}')
            # Real inference through the deployed adapter, with no user data.
            probe('egress:leader_help_assistant_dev',
                'fetch("https://ai.bunny.ge/api/v1/health",{redirect:"error",signal:AbortSignal.timeout(20000),headers:{Authorization:"Bearer "+process.env.BUNNY_CHAT_API_KEY}}).then(async r=>{await r.body?.cancel();if(!r.ok)throw {code:"HEALTH_HTTP_"+r.status};console.log("AI health HTTP reachable")}).catch(e=>{console.log(JSON.stringify({errorCode:e.cause?.code||e.code||"FETCH_FAILED"}));process.exitCode=1})', timeout=25)
            result = probe('inference:leader_help_assistant_dev',
                'require("./dist/modules/help/help.bunny").requestBunnyAnswer([{role:"user",text:"Представься одним коротким предложением."}],new AbortController().signal).then(x=>{if(!x.text)throw {code:"EMPTY_ANSWER"};console.log(JSON.stringify({model:x.model,answerReceived:true}))}).catch(e=>{console.log(JSON.stringify({errorCode:e.code||"INFERENCE_FAILED"}));process.exitCode=1})', timeout=130)
            if any(r.inspect(name)['Id'] != identity for name, identity in protected.items()):
                raise RuntimeError('Unrelated container changed')
            print(result)
            print('Bunny bound to dev API and worker; unrelated containers unchanged')
        except Exception:
            phase('rollback-after-' + stage)
            if previous is None:
                binding.unlink(missing_ok=True)
            else:
                binding.write_bytes(previous)
                binding.chmod(0o600)
            if 'help-assistant-worker' not in old['services']:
                r.run(['docker', 'stop', 'leader_help_assistant_dev'])
                r.run(['docker', 'rm', 'leader_help_assistant_dev'])
            rollback = ['docker', 'compose', '-p', 'leader-api-dev', '--project-directory', str(root), '-f', str(state / 'previous-compose.private.json')]
            services = ['api'] + (['help-assistant-worker'] if 'help-assistant-worker' in old['services'] else [])
            r.run(rollback + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never'] + services, timeout=300)
            r.healthy('leader_api_dev')
            raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No resolved Compose or upstream response bodies.
        print('Bunny dev activation failed at ' + stage + ': ' + type(error).__name__ + ': ' + str(error))
        raise SystemExit(1)
