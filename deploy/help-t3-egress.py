#!/usr/bin/env python3
"""Maintain only dev API -> relay.t3.codes:443 in the existing isolation chain."""
import ipaddress
import json
import shlex
import socket
import subprocess

IPT = ['/usr/sbin/iptables', '-w', '5']
CHAIN = 'LP_DEV_EGRESS'
COMMENT = 'leader-help-t3-relay-https'

network = json.loads(subprocess.check_output(['docker', 'network', 'inspect', 'leader-api-dev_default']))[0]
assert network['Name'] == 'leader-api-dev_default'
subnet = network['IPAM']['Config'][0]['Subnet']
assert ipaddress.ip_network(subnet).is_private
# Resolve before touching rules. A DNS outage preserves the prior working rules.
addresses = sorted({row[4][0] for row in socket.getaddrinfo('relay.t3.codes', 443, socket.AF_INET, socket.SOCK_STREAM)})
assert addresses and all(ipaddress.ip_address(address).is_global for address in addresses)
rules = subprocess.check_output(IPT + ['-S', CHAIN], text=True)
assert '-j REJECT' in rules or '-j DROP' in rules
for address in addresses:
    rule = ['-s', subnet, '-d', address, '-p', 'tcp', '--dport', '443', '-m', 'comment', '--comment', COMMENT, '-j', 'RETURN']
    if subprocess.run(IPT + ['-C', CHAIN, *rule], capture_output=True).returncode:
        subprocess.run(IPT + ['-I', CHAIN, '2', *rule], check=True, capture_output=True)
for line in subprocess.check_output(IPT + ['-S', CHAIN], text=True).splitlines():
    tokens = shlex.split(line)
    if COMMENT not in tokens:
        continue
    destination = tokens[tokens.index('-d') + 1].split('/')[0]
    source = tokens[tokens.index('-s') + 1]
    if destination not in addresses or source != subnet:
        subprocess.run(IPT + ['-D', *tokens[1:]], check=True, capture_output=True)
print(json.dumps({'scope': 'dev API/worker only', 'destination': 'relay.t3.codes', 'port': 443, 'ipv4Addresses': len(addresses)}))
