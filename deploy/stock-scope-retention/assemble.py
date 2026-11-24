"""Make the scoped Docker build context from the exact current production base.

Usage: python3 assemble.py <empty-build-directory>
Then build the image with docker build --network=none --pull=false <directory>.
"""
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

source = Path(__file__).resolve().parent
target = Path(sys.argv[1]).resolve()
manifest = json.loads((source / 'manifest.json').read_text())
target.mkdir(parents=True, exist_ok=True)
if any(target.iterdir()):
    sys.exit('An empty build directory is required')

def checked(*args):
    return subprocess.check_output(args, text=True).strip()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None

image = checked('docker', 'image', 'inspect', '--format', '{{.Id}}', manifest['baseTag'])
if image != manifest['baseImage']:
    sys.exit('Base image differs from the reviewed production image')
container = checked('docker', 'create', '--network=none', '--entrypoint=/bin/false', image)
try:
    for name, hashes in manifest['files'].items():
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if hashes['before'] is not None:
            subprocess.run(['docker', 'cp', container + ':/app/' + name, dest], check=True)
        if digest(dest) != hashes['before']:
            sys.exit('Source SHA-256 differs for ' + name)
finally:
    checked('docker', 'rm', container)
with (source / 'runtime.patch').open('rb') as patch:
    subprocess.run(['patch', '--batch', '--fuzz=0', '-p1'], cwd=target, stdin=patch, check=True)
for name, hashes in manifest['files'].items():
    if digest(target / name) != hashes['after']:
        sys.exit('Patched SHA-256 differs for ' + name)
shutil.copy(source / 'Dockerfile', target / 'Dockerfile')
