#!/usr/bin/env python3
"""Configure the private pilot mount and create missing folders without overwriting files."""
import base64
import json
import os
from pathlib import Path
import subprocess
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
OCC = ['docker', 'compose', '--project-directory', str(ROOT), 'exec', '-T',
       '-u', 'www-data', 'nextcloud', 'php', 'occ', '--no-warnings']


def env_file(path):
    values = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def occ(*args, payload=None):
    result = subprocess.run(OCC + list(args), input=payload, capture_output=True,
                            text=True, timeout=120)
    if result.returncode:
        # CLI output may contain storage configuration: never print it.
        raise RuntimeError('Nextcloud command failed: ' + args[0])
    return result.stdout


def main():
    os.umask(0o077)
    env = env_file(ROOT / '.env')
    storage = env_file(ROOT / 'secrets' / 'knowledge.env')
    if (storage.get('KNOWLEDGE_S3_ENDPOINT') != 'https://s3.ru1.storage.beget.cloud'
            or storage.get('KNOWLEDGE_S3_BUCKET') != '66f2164cfa3e-leader-knowledge'):
        raise RuntimeError('Unexpected knowledge bucket; application storage will not be used')
    user = env['NEXTCLOUD_ADMIN_USER']
    point = '/База знаний'
    occ('app:enable', 'files_external')
    # Capture full configuration only in process memory; never log it.
    mounts = json.loads(occ('files_external:list', '--output=json', '--show-password'))
    matching = [mount for mount in mounts if mount['mount_point'] == point and mount['applicable_users'] == [user]]
    if not matching:
        mount = {
            'mount_id': 0, 'mount_point': point,
            'storage': '\\OCA\\Files_External\\Lib\\Storage\\AmazonS3',
            'authentication_type': 'amazons3::accesskey',
            'configuration': {
                'bucket': storage['KNOWLEDGE_S3_BUCKET'],
                'hostname': 's3.ru1.storage.beget.cloud', 'port': '443',
                'region': storage.get('KNOWLEDGE_S3_REGION', 'ru1'),
                'key': storage['KNOWLEDGE_S3_ACCESS_KEY'],
                'secret': storage['KNOWLEDGE_S3_SECRET_KEY'],
                'use_ssl': True, 'use_path_style': True, 'legacy_auth': False,
            },
            'options': {'enable_sharing': False, 'filesystem_check_changes': 1},
            'applicable_users': [user], 'applicable_groups': [],
        }
        occ('files_external:import', '-', payload=json.dumps([mount]))
        mounts = json.loads(occ('files_external:list', '--output=json', '--show-password'))
        matching = [mount for mount in mounts if mount['mount_point'] == point and mount['applicable_users'] == [user]]
    if len(matching) != 1:
        raise RuntimeError('Ambiguous knowledge mount')
    mount = matching[0]
    if (mount['configuration'].get('bucket') != storage['KNOWLEDGE_S3_BUCKET']
            or mount.get('applicable_users') != [user]
            or mount.get('applicable_groups')):
        raise RuntimeError('Existing mount differs from private pilot configuration')
    occ('files_external:verify', str(mount['mount_id']))
    occ('background:cron')
    occ('config:system:set', 'default_phone_region', '--value=RU')
    occ('config:system:set', 'shareapi_enabled', '--type=boolean', '--value=false')
    password = (ROOT / 'secrets' / 'admin_password').read_text().strip()
    auth = base64.b64encode((user + ':' + password).encode()).decode()
    base = 'http://127.0.0.1:' + env['NEXTCLOUD_PORT'] + '/remote.php/dav/files/' + quote(user) + quote(point)
    folders = json.loads((ROOT / 'folders.json').read_text(encoding='utf-8-sig'))
    created = 0
    for folder in folders:
        if folder.startswith('/') or '..' in folder.split('/'):
            raise RuntimeError('Invalid folder path')
        request = Request(base + '/' + quote(folder), method='MKCOL',
                          headers={'Authorization': 'Basic ' + auth,
                                   'Host': 'cloud.leader-product.ru'})
        try:
            with urlopen(request, timeout=45) as response:
                if response.status != 201:
                    raise RuntimeError('Unexpected folder response')
                created += 1
        except HTTPError as error:
            if error.code != 405:
                raise RuntimeError('Folder creation failed with HTTP ' + str(error.code)) from None
    print(json.dumps({'mountId': mount['mount_id'], 'adminOnly': True,
                      'foldersCreated': created, 'foldersTotal': len(folders)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
