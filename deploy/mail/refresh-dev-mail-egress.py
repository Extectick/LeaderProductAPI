#!/usr/bin/env python3
"""DEV personal mail: two verified containers, two fixed providers, TLS SMTP only."""
import argparse, fcntl, ipaddress, json, os, shlex, socket, subprocess
from pathlib import Path
TAG = 'leader-dev-personal-mail-tls'
CHAIN = 'LP_DEV_EGRESS'
HOSTS = ('smtp.mail.ru', 'smtp.yandex.ru')
NAMES = {'leader_api_dev': 'api', 'leader_help_assistant_dev': 'help-assistant-worker'}

def run(args):
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError('Scoped mail egress command failed')
    return p.stdout

def owned(rule):
    return '--comment' in rule and rule[rule.index('--comment') + 1] == TAG

def desired():
    destinations = set()
    for host in HOSTS:
        addresses = {r[4][0] for r in socket.getaddrinfo(host, 465, socket.AF_INET, socket.SOCK_STREAM)}
        if not addresses or len(addresses) > 32 or any(not ipaddress.ip_address(a).is_global for a in addresses):
            raise RuntimeError('Unexpected provider address')
        destinations.update(addresses)
    sources = []
    for c in json.loads(run(['docker', 'inspect', *NAMES])):
        name = c['Name'].lstrip('/')
        labels = c['Config']['Labels']
        if name not in NAMES or labels.get('com.docker.compose.project') != 'leader-api-dev' or labels.get('com.docker.compose.service') != NAMES[name] or not c['State']['Running']:
            raise RuntimeError('Unexpected DEV container')
        net = c['NetworkSettings']['Networks'].get('leader-api-dev_default')
        if not net or net.get('Gateway') != '172.19.0.1' or ipaddress.ip_address(net['IPAddress']) not in ipaddress.ip_network('172.19.0.0/16'):
            raise RuntimeError('Unexpected DEV network')
        sources.append(net['IPAddress'])
    if len(set(sources)) != 2:
        raise RuntimeError('Expected two distinct DEV addresses')
    return [['-s', source + '/32', '-d', dest + '/32', '-p', 'tcp', '-m', 'tcp', '--dport', '465', '-m', 'comment', '--comment', TAG, '-j', 'RETURN'] for source in sorted(sources) for dest in sorted(destinations)]

def refresh(apply=False, remove=False):
    rules = [shlex.split(s)[2:] for s in run(['iptables', '-w', '10', '-S', CHAIN]).splitlines() if s.startswith('-A ')]
    if not rules or rules[-1][:2] != ['-j', 'REJECT'] or any('-j' in r and r[r.index('-j') + 1] == 'REJECT' for r in rules[:-1]):
        raise RuntimeError('Expected final DEV isolation REJECT')
    current = [r for r in rules if owned(r)]
    target = [] if remove else desired()
    if apply:
        for rule in target:
            if rule not in current:
                count = sum(s.startswith('-A ') for s in run(['iptables', '-w', '10', '-S', CHAIN]).splitlines())
                run(['iptables', '-w', '10', '-I', CHAIN, str(count), *rule])
        kept = set()
        for rule in current:
            if rule not in target or tuple(rule) in kept:
                run(['iptables', '-w', '10', '-D', CHAIN, *rule])
            kept.add(tuple(rule))
    return {'applied': apply, 'ruleCount': len(target), 'providers': HOSTS, 'port': 465, 'tag': TAG}

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--apply', action='store_true'); p.add_argument('--remove', action='store_true'); a = p.parse_args()
    if os.geteuid() != 0: raise SystemExit('Run as root on host126')
    with open('/run/lock/leader-dev-personal-mail-egress.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        print(json.dumps(refresh(a.apply, a.remove)))
