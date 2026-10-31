#!/usr/bin/env python3
"""Prepare a private Linux deployment directory; never start or recreate services."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    if os.name != 'posix':
        raise SystemExit('Run this preparation on the Linux host to apply private file permissions.')
    root = args.directory.resolve(strict=True)
    if root != Path(__file__).resolve().parent:
        raise SystemExit('Run the script from its own copied deployment directory.')
    if not (root / 'compose.yml').is_file():
        raise SystemExit('Compose definition missing.')
    os.umask(0o077)
    os.chmod(root, 0o700)
    private = root / 'secrets'
    if private.is_symlink():
        raise SystemExit('Secret directory must not be a symlink.')
    private.mkdir(mode=0o700, exist_ok=True)
    os.chmod(private, 0o700)
    created = []
    for name in ('database_password', 'redis_password', 'admin_password'):
        target = private / name
        if target.is_symlink():
            raise SystemExit('Secret files must not be symlinks.')
        if not target.exists():
            with target.open('x', encoding='utf-8') as file:
                file.write(secrets.token_urlsafe(36) + '\n')
            created.append(name)
        if len(target.read_text().strip()) < 24:
            raise SystemExit('Existing secret is empty or too short; it was not replaced.')
        # The host parent is 0700. Compose bind-mounts these files for www-data/postgres.
        os.chmod(target, 0o444)
    redis_conf = private / 'redis.conf'
    if redis_conf.is_symlink():
        raise SystemExit('Redis config must not be a symlink.')
    if not redis_conf.exists():
        password = (private / 'redis_password').read_text().strip()
        with redis_conf.open('x', encoding='utf-8') as file:
            file.write('bind 0.0.0.0\nprotected-mode yes\nrequirepass ' + password + '\n'
                       'maxmemory 64mb\nmaxmemory-policy noeviction\nsave ""\nappendonly no\n')
        os.chmod(redis_conf, 0o444)
    env = root / '.env'
    if env.is_symlink():
        raise SystemExit('Environment file must not be a symlink.')
    if not env.exists():
        shutil.copyfile(root / '.env.example', env)
        created.append('.env')
    os.chmod(env, 0o600)
    print(json.dumps({'prepared': True, 'created': created, 'credentialsPrinted': False}))


if __name__ == '__main__':
    main()
