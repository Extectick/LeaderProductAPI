#!/usr/bin/env python3
"""Create a fresh local source, editor and read-only indexer; leave the old source alone."""
import base64
import json
import os
import re
import secrets
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from local_126 import ROOT, COMPOSE, env_file, occ, private_write, run, volume_path


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    os.umask(0o077)
    env = env_file(ROOT / '.env')
    url = urlsplit(env['NEXTCLOUD_BASE_URL'])
    source_key = env.get('KNOWLEDGE_SOURCE_KEY', 'company-126-dev')
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.path not in ('', '/') or url.query or url.fragment
            or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{2,80}', source_key)):
        raise RuntimeError('Set an HTTPS origin and a distinct valid knowledge source key')
    port = int(env['NEXTCLOUD_PORT'])
    if not 1024 <= port <= 65535:
        raise RuntimeError('Invalid loopback port')
    volume_path('/srv/knowledge')
    run(COMPOSE + ['exec', '-T', '-u', 'root', 'nextcloud', 'install', '-d',
                   '-m', '0750', '-o', 'www-data', '-g', 'www-data', '/srv/knowledge'])
    users = json.loads(occ('user:list', '--output=json'))
    passwords = {}
    for user, title in [('knowledge-editor', 'Редактор базы знаний'),
                        ('knowledge-indexer', 'Индексатор базы знаний')]:
        path = ROOT / 'secrets' / (user + '_password')
        if path.is_symlink() or user in users and not path.is_file():
            raise RuntimeError('Existing account has no managed secret; refusing password reset')
        if not path.exists():
            private_write(path, secrets.token_urlsafe(36) + '\n')
        passwords[user] = path.read_text().strip()
        if len(passwords[user]) < 24:
            raise RuntimeError('Managed account password is too short')
        if user not in users:
            occ('user:add', '--password-from-env', '--display-name=' + title,
                user, password=passwords[user])
        info = json.loads(occ('user:info', user, '--output=json'))
        if 'admin' in info.get('groups', []):
            raise RuntimeError('Editor and indexer must not be administrators')
    occ('app:enable', 'files_external')
    s3_enabled = env.get('KNOWLEDGE_STORAGE') == 's3'
    storage = env_file(ROOT / 'secrets/s3.env') if s3_enabled else {}
    bucket = 'leader-knowledge-126'
    for allowed, readonly in [([env['NEXTCLOUD_ADMIN_USER'], 'knowledge-editor'], False),
                              (['knowledge-indexer'], True)]:
        mounts = json.loads(occ('files_external:list', '--output=json', '--show-password'))
        matches = [m for m in mounts if m['mount_point'] == '/База знаний'
                   and sorted(m['applicable_users']) == sorted(allowed)]
        if s3_enabled and len(matches) == 1 and matches[0]['configuration'].get('datadir', '').rstrip('/') == '/srv/knowledge':
            if run(COMPOSE + ['exec', '-T', '-u', 'root', 'nextcloud', 'find',
                              '/srv/knowledge', '-type', 'f', '-print', '-quit']).strip():
                raise RuntimeError('Local mount contains files; migrate them before switching its configuration')
            saved = ROOT / 'runtime' / ('local-mount-before-s3-' + str(matches[0]['mount_id']) + '.private.json')
            saved.parent.mkdir(mode=0o700, exist_ok=True)
            if not saved.exists():
                private_write(saved, json.dumps(matches[0], indent=2) + '\n')
            occ('files_external:delete', '--yes', str(matches[0]['mount_id']))
            matches = []
        if not matches:
            configuration = ({'bucket': bucket, 'hostname': 'knowledge-s3', 'port': '9000',
                              'region': 'us-east-1', 'key': storage['RUSTFS_ACCESS_KEY'],
                              'secret': storage['RUSTFS_SECRET_KEY'], 'use_ssl': False,
                              'use_path_style': True, 'legacy_auth': False}
                             if s3_enabled else {'datadir': '/srv/knowledge/'})
            mount = {'mount_id': 0, 'mount_point': '/База знаний',
                     'storage': ('\\OCA\\Files_External\\Lib\\Storage\\AmazonS3' if s3_enabled else '\\OC\\Files\\Storage\\Local'),
                     'authentication_type': 'amazons3::accesskey' if s3_enabled else 'null::null',
                     'configuration': configuration,
                     'options': {'readonly': readonly, 'enable_sharing': False,
                                 'filesystem_check_changes': 1},
                     'applicable_users': allowed, 'applicable_groups': []}
            occ('files_external:import', '-', payload=json.dumps([mount]))
            mounts = json.loads(occ('files_external:list', '--output=json', '--show-password'))
            matches = [m for m in mounts if m['mount_point'] == '/База знаний'
                       and sorted(m['applicable_users']) == sorted(allowed)]
        valid_storage = (len(matches) == 1 and (matches[0]['configuration'].get('bucket') == bucket
                         and matches[0]['configuration'].get('hostname') == 'knowledge-s3' if s3_enabled
                         else matches[0]['configuration'].get('datadir', '').rstrip('/') == '/srv/knowledge'))
        if (len(matches) != 1 or matches[0]['applicable_groups'] or not valid_storage
                or bool(matches[0]['options'].get('readonly', False)) != readonly
                or matches[0]['options'].get('enable_sharing', True)):
            raise RuntimeError('Existing mount differs from the private local source')
        occ('files_external:verify', str(matches[0]['mount_id']))
    occ('background:cron')
    occ('config:system:set', 'default_phone_region', '--value=RU')
    occ('config:system:set', 'shareapi_enabled', '--type=boolean', '--value=false')
    opener = build_opener(NoRedirect())

    def dav(user, path, method, data=None):
        auth = base64.b64encode((user + ':' + passwords[user]).encode()).decode()
        target = ('http://127.0.0.1:' + str(port) + '/remote.php/dav/files/' + quote(user)
                  + '/' + quote('База знаний') + '/' + quote(path, safe='/'))
        request = Request(target, method=method, data=data,
                          headers={'Authorization': 'Basic ' + auth, 'Host': url.netloc})
        try:
            with opener.open(request, timeout=30) as response:
                return response.status
        except HTTPError as error:
            return error.code

    for folder in json.loads((ROOT / 'folders.json').read_text(encoding='utf-8-sig')):
        if folder.startswith('/') or any(p in ('.', '..', '') for p in folder.split('/')):
            raise RuntimeError('Invalid folder path')
        if dav('knowledge-editor', folder, 'MKCOL') not in (201, 405):
            raise RuntimeError('Folder creation failed')
    if dav('knowledge-indexer', '', 'PROPFIND') != 207:
        raise RuntimeError('Indexer cannot read the new source')
    probe = '.indexer-permission-probe-' + secrets.token_hex(8) + '.txt'
    status = dav('knowledge-indexer', probe, 'PUT', b'read-only permission probe')
    if status != 403:
        if status in (200, 201, 204):
            dav('knowledge-editor', probe, 'DELETE')
        raise RuntimeError('Indexer write denial was not confirmed')
    private_write(ROOT / '.env.knowledge.worker',
                  'KNOWLEDGE_ENABLED=true\nKNOWLEDGE_PUBLICATION_MODE=folder\n'
                  + 'KNOWLEDGE_SOURCE_KEY=' + source_key + '\n'
                  + 'KNOWLEDGE_NEXTCLOUD_URL=' + url.geturl().rstrip('/') + '\n'
                  + 'KNOWLEDGE_NEXTCLOUD_USER=knowledge-indexer\n'
                  + 'KNOWLEDGE_NEXTCLOUD_PASSWORD=' + passwords['knowledge-indexer'] + '\n'
                  + 'KNOWLEDGE_NEXTCLOUD_ROOT=База знаний\n')
    print(json.dumps({'configured': True, 'sourceKey': source_key, 'storage': 'local-s3' if s3_enabled else 'local-volume',
                      'indexerReadOnlyVerified': True, 'credentialsPrinted': False}))


if __name__ == '__main__':
    main()
