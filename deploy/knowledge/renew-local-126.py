#!/usr/bin/env python3
"""Renew only the dedicated LAN certificate, using its existing private CA."""
import subprocess
from local_126 import ROOT, COMPOSE, run

tls = ROOT / 'secrets/tls'
check = subprocess.run(['openssl', 'x509', '-checkend', '2592000', '-noout',
                        '-in', str(tls / 'server.crt')], capture_output=True)
if check.returncode == 0:
    print('Knowledge LAN certificate does not need renewal')
elif check.returncode == 1:
    target = tls / 'server.renewed.crt'
    run(['openssl', 'x509', '-req', '-in', str(tls / 'server.csr'), '-CA', str(tls / 'ca.crt'),
         '-CAkey', str(tls / 'ca.key'), '-CAserial', str(tls / 'ca.srl'), '-out', str(target),
         '-days', '365', '-sha256', '-extfile', str(tls / 'server.ext')])
    run(['openssl', 'verify', '-CAfile', str(tls / 'ca.crt'), str(target)])
    # Preserve the inode of the single-file Docker bind mount.
    (tls / 'server.crt').write_bytes(target.read_bytes())
    target.unlink()
    run(COMPOSE + ['exec', '-T', 'proxy', 'nginx', '-t'])
    run(COMPOSE + ['exec', '-T', 'proxy', 'nginx', '-s', 'reload'])
    print('Knowledge LAN certificate renewed')
else:
    raise SystemExit('Certificate inspection failed')
