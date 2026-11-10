#!/usr/bin/env python3
"""Allow only dev -> this knowledge HTTPS proxy through the existing dev isolation chain."""
import ipaddress
import json
import shlex
import subprocess

IPT = ['/usr/sbin/iptables', '-w', '5']


def output(args):
    return subprocess.check_output(args, text=True)


network = json.loads(output(['docker', 'network', 'inspect', 'leader-api-dev_default']))[0]
subnet = network['IPAM']['Config'][0]['Subnet']
proxy = json.loads(output(['docker', 'inspect', 'leader-knowledge-126-proxy-1']))[0]
target = proxy['NetworkSettings']['Networks']['leader-knowledge-126_default']['IPAddress']
if not ipaddress.ip_network(subnet).is_private or not ipaddress.ip_address(target).is_private:
    raise SystemExit('Unexpected network scope')
comment = 'leader-knowledge-126-https'
rule = ['-s', subnet, '-d', target, '-p', 'tcp', '--dport', '443',
        '-m', 'comment', '--comment', comment, '-j', 'RETURN']
if subprocess.run(IPT + ['-C', 'LP_DEV_EGRESS', *rule], capture_output=True).returncode:
    # Keep the existing ESTABLISHED rule first, and the final isolation REJECT intact.
    subprocess.run(IPT + ['-I', 'LP_DEV_EGRESS', '2', *rule], check=True, capture_output=True)
for line in output(IPT + ['-S', 'LP_DEV_EGRESS']).splitlines():
    tokens = shlex.split(line)
    if comment not in tokens:
        continue
    normalized = tokens[2:]
    # iptables normalizes a host address to /32 and adds '-m tcp'.
    if target + '/32' not in normalized and target not in normalized:
        subprocess.run(IPT + ['-D', *tokens[1:]], check=True, capture_output=True)
print(json.dumps({'allowed': 'dev-to-knowledge-https-only', 'destination': target, 'port': 443}))
