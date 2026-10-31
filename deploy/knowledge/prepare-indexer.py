#!/usr/bin/env python3
"""Provision a non-admin Nextcloud reader; do not give the API S3/admin credentials."""
import json
import os
from pathlib import Path
import secrets
import subprocess

root = Path(__file__).resolve().parent
compose = ['docker', 'compose', '--project-directory', str(root), 'exec', '-T', '-u', 'www-data']


def occ(*args, payload=None, password=None):
    env = dict(os.environ)
    command = list(compose)
    if password:
        env['OC_PASS'] = password
        command += ['-e', 'OC_PASS']
    command += ['nextcloud', 'php', 'occ', '--no-warnings', *args]
    result = subprocess.run(command, input=payload, capture_output=True, text=True, env=env, timeout=120)
    if result.returncode:
        raise RuntimeError('Indexer setup failed at ' + args[0])
    return result.stdout


def main():
    os.umask(0o077)
    user = 'knowledge-indexer'
    password_file = root / 'secrets/indexer_password'
    if password_file.is_symlink():
        raise RuntimeError('Unexpected symlink')
    users = json.loads(occ('user:list', '--output=json'))
    if user in users and not password_file.is_file():
        raise RuntimeError('Existing account has no managed password; refusing to reset it')
    if not password_file.exists():
        password_file.write_text(secrets.token_urlsafe(36) + '\n')
    password_file.chmod(0o444)
    password = password_file.read_text().strip()
    if user not in users:
        occ('user:add', '--password-from-env', '--display-name=Индексатор базы знаний', user, password=password)
    info = json.loads(occ('user:info', user, '--output=json'))
    if 'admin' in info.get('groups', []):
        raise RuntimeError('Indexer must not be an administrator')
    mounts = json.loads(occ('files_external:list', '--output=json', '--show-password'))
    admin = next(m for m in mounts if m['mount_point'] == '/База знаний' and m['applicable_users'] == ['knowledge-admin'])
    existing = [m for m in mounts if m['mount_point'] == '/База знаний' and m['applicable_users'] == [user]]
    if not existing:
        mount = dict(admin)
        mount['mount_id'] = 0
        mount['applicable_users'] = [user]
        mount['applicable_groups'] = []
        mount['options'] = {'readonly': True, 'enable_sharing': False, 'filesystem_check_changes': 1}
        occ('files_external:import', '-', payload=json.dumps([mount]))
        mounts = json.loads(occ('files_external:list', '--output=json', '--show-password'))
        existing = [m for m in mounts if m['mount_point'] == '/База знаний' and m['applicable_users'] == [user]]
    if len(existing) != 1 or not existing[0]['options'].get('readonly') or existing[0]['applicable_groups']:
        raise RuntimeError('Indexer mount is not private and read-only')
    occ('files_external:verify', str(existing[0]['mount_id']))
    target = root / '.env.knowledge.worker'
    target.write_text('KNOWLEDGE_ENABLED=true\nKNOWLEDGE_SOURCE_KEY=company-dev\n'
                      'KNOWLEDGE_NEXTCLOUD_URL=https://cloud.leader-product.ru\n'
                      'KNOWLEDGE_NEXTCLOUD_USER=knowledge-indexer\n'
                      'KNOWLEDGE_NEXTCLOUD_PASSWORD=' + password + '\n'
                      'KNOWLEDGE_NEXTCLOUD_ROOT=База знаний\n', encoding='utf-8')
    target.chmod(0o600)
    print(json.dumps({'indexer': user, 'admin': False, 'mountReadOnly': True, 'credentialsPrinted': False}))


if __name__ == '__main__':
    main()
