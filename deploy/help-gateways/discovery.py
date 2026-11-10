"""Fixed, read-only LAN observations, sent over pinned SSH by executor.py.

No host, command, file path, subnet or port is accepted from a model. Values
returned by DHCP/printers are untrusted device data, never instructions.
"""
import concurrent.futures
import csv
import http.client
import ipaddress
import json
import re
import socket
import struct
import subprocess
import time
from pathlib import Path

NETWORKS = {'nsk': ('192.168.30.0/24', '192.168.20.0/24'), 'omsk': ('192.168.0.0/24',)}
MAX_FILE = 4 * 1024 * 1024
MAX_ROWS = 256

def read_fixed(path):
    with Path(path).open('rb') as file:
        raw = file.read(MAX_FILE + 1)
    if len(raw) > MAX_FILE:
        raise ValueError('SOURCE_TOO_LARGE')
    return raw.decode('utf-8', errors='replace')

def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            universal_newlines=True, timeout=4)
    if result.returncode or len(result.stdout) > 100000:
        raise ValueError('UNAVAILABLE')
    return result.stdout

def clean(value, limit=180):
    return re.sub(r'[\x00-\x1f\x7f]', ' ', str(value))[:limit]

def allowed_ip(value, networks):
    try:
        ip = ipaddress.ip_address(value)
        return any(ip in ipaddress.ip_network(net) and ip not in
                   (ipaddress.ip_network(net).network_address, ipaddress.ip_network(net).broadcast_address)
                   for net in networks)
    except ValueError:
        return False

def verified_networks(gateway, addresses):
    present = set()
    for interface in addresses:
        if 'UP' not in interface.get('flags', []):
            continue
        for addr in interface.get('addr_info', []):
            if addr.get('family') == 'inet' and addr.get('prefixlen') == 24:
                present.add(str(ipaddress.ip_interface(addr['local'] + '/24').network))
    return [net for net in NETWORKS[gateway] if net in present]

def isc_leases(text, networks):
    # ISC repeats a lease over time; the final block is authoritative for that IP.
    rows = {}
    for ip, body in re.findall(r'\blease\s+([0-9.]+)\s*\{([^{}]*)\}', text):
        if not allowed_ip(ip, networks):
            continue
        row = {'ip': ip}
        for key, pattern in [('mac', r'\bhardware ethernet\s+([a-fA-F0-9:]+)\s*;'),
                             ('hostname', r'\bclient-hostname\s+"([^"\r\n]*)"\s*;'),
                             ('state', r'\bbinding state\s+(\w+)\s*;'),
                             ('ends', r'\bends\s+([^;]+);')]:
            found = re.search(pattern, body)
            if found:
                row[key] = clean(found.group(1))
        rows[ip] = row
    return list(rows.values())

def isc_reservations(text, networks):
    rows = []
    # Project only named host stanzas; global options, credentials, keys and
    # arbitrary config text never leave this reader. Includes are not followed.
    for name, body in re.findall(r'\bhost\s+([^\s{]+)\s*\{([^{}]*)\}', text):
        fixed = re.search(r'\bfixed-address\s+([^;]+);', body)
        mac = re.search(r'\bhardware ethernet\s+([a-fA-F0-9:]+)\s*;', body)
        for ip in fixed.group(1).split(',') if fixed else []:
            ip = ip.strip()
            if allowed_ip(ip, networks):
                rows.append({'ip': ip, 'hostname': clean(name), **({'mac': mac.group(1)} if mac else {})})
    return rows

def bounded_rows(rows):
    return {'rows': rows[:MAX_ROWS], 'totalRows': len(rows), 'truncated': len(rows) > MAX_ROWS}

def dhcp(gateway, networks):
    result = {}
    if gateway == 'nsk':
        sources = [('leases', '/var/lib/dhcp/dhcpd.leases', isc_leases),
                   ('reservations', '/etc/dhcp/dhcpd.conf', isc_reservations)]
        for key, path, parser in sources:
            try:
                result[key] = {'available': True, **bounded_rows(parser(read_fixed(path), networks))}
            except (OSError, ValueError):
                result[key] = {'available': False, 'reason': 'SOURCE_UNAVAILABLE'}
    else:
        try:
            rows = []
            for row in csv.DictReader(read_fixed('/var/lib/kea/kea-leases4.csv').splitlines()):
                if allowed_ip(row.get('address', ''), networks):
                    rows.append({key: clean(row.get(source, '')) for key, source in
                                 [('ip', 'address'), ('mac', 'hwaddr'), ('hostname', 'hostname'), ('state', 'state'), ('expire', 'expire')]})
            result['leases'] = {'available': True, **bounded_rows(rows)}
        except (OSError, ValueError):
            result['leases'] = {'available': False, 'reason': 'SOURCE_UNAVAILABLE'}
        # Kea supports nested configs and includes. Parse JSON only; do not
        # expose raw config or guess at unsupported formats.
        try:
            value = json.loads(read_fixed('/etc/kea/kea-dhcp4.conf'))['Dhcp4']
            rows = []
            for subnet in [value] + value.get('subnet4', []):
                for row in subnet.get('reservations', []):
                    if allowed_ip(row.get('ip-address', ''), networks):
                        rows.append({key: clean(row.get(source, '')) for key, source in
                                     [('ip', 'ip-address'), ('mac', 'hw-address'), ('hostname', 'hostname')]})
            result['reservations'] = {'available': True, **bounded_rows(rows)}
        except (OSError, ValueError, KeyError, TypeError):
            result['reservations'] = {'available': False, 'reason': 'SOURCE_UNAVAILABLE'}
    result['limitations'] = ['DHCP records do not prove a device is online or identify its model.',
                            'Static devices can be absent; included DHCP configuration files are not read.']
    return result

def neighbours(networks):
    try:
        text = command(['ip', '-j', '-4', 'neigh', 'show'])
        try:
            rows = json.loads(text)
        except ValueError:
            # Ubuntu18 iproute2 accepts -j but prints neighbour rows as text.
            # Parse only known address/device/MAC/state fields, not whole lines.
            rows = []
            for line in text.splitlines():
                found = re.fullmatch(r'([0-9.]+) dev ([A-Za-z0-9_.:-]+)(?: lladdr ([a-fA-F0-9:]+))?\s+(?:router\s+)?(INCOMPLETE|REACHABLE|STALE|DELAY|PROBE|FAILED|NOARP|PERMANENT)', line.strip())
                if found:
                    ip, dev, mac, state = found.groups()
                    rows.append({'dst': ip, 'dev': dev, 'state': [state], **({'lladdr': mac} if mac else {})})
        return {'available': True, **bounded_rows([
            {key: row[key] for key in ('dst', 'lladdr', 'dev', 'state') if key in row}
            for row in rows if allowed_ip(row.get('dst', ''), networks)])}
    except (ValueError, OSError, subprocess.SubprocessError):
        return {'available': False, 'reason': 'SOURCE_UNAVAILABLE'}

def ipp_attributes(ip):
    # IPP Get-Printer-Attributes (0x000b), never Print-Job or a configuration op.
    def attr(tag, name, value):
        name, value = name.encode(), value.encode()
        return bytes([tag]) + struct.pack('!H', len(name)) + name + struct.pack('!H', len(value)) + value
    body = b'\x01\x01\x00\x0b\x00\x00\x00\x01\x01'
    body += attr(0x47, 'attributes-charset', 'utf-8') + attr(0x48, 'attributes-natural-language', 'en')
    body += attr(0x45, 'printer-uri', 'ipp://' + ip + '/ipp/print')
    body += attr(0x44, 'requested-attributes', 'printer-make-and-model')
    body += attr(0x44, '', 'printer-name') + attr(0x44, '', 'printer-location') + b'\x03'
    conn = http.client.HTTPConnection(ip, 631, timeout=0.7)
    try:
        conn.request('POST', '/ipp/print', body, {'Content-Type': 'application/ipp'})
        response = conn.getresponse()
        data = response.read(16385)
        if response.status != 200 or len(data) > 16384 or len(data) < 9 or int.from_bytes(data[2:4], 'big') > 0xff:
            return {}
        names = {'printer-make-and-model': 'model', 'printer-name': 'name', 'printer-location': 'location'}
        result, pos = {}, 8
        while pos < len(data):
            tag = data[pos]; pos += 1
            if tag == 3:
                break
            if tag <= 0xf:
                continue
            length = int.from_bytes(data[pos:pos+2], 'big'); pos += 2
            name = data[pos:pos+length].decode('utf-8', errors='replace'); pos += length
            length = int.from_bytes(data[pos:pos+2], 'big'); pos += 2
            value = data[pos:pos+length]; pos += length
            if pos > len(data):
                return {}
            if name in names and tag in (0x41, 0x42):
                result[names[name]] = clean(value.decode('utf-8', errors='replace'))
        return result
    except (OSError, http.client.HTTPException, ValueError):
        return {}
    finally:
        conn.close()

def printer_host(ip, deadline):
    ports = []
    for port in (631, 9100, 515):
        if time.monotonic() >= deadline:
            return False, None
        try:
            with socket.create_connection((ip, port), timeout=0.25):
                ports.append(port)
        except OSError:
            pass
    if not ports:
        return True, None
    attributes = ipp_attributes(ip) if 631 in ports and time.monotonic() < deadline else {}
    return True, {'ip': ip, 'openPorts': ports, 'identification': 'ipp_attributes' if attributes else 'printer_port_candidate',
                  **attributes}

def printers(networks):
    # The inventory constants AND current connected /24s must agree. Never
    # probe a supplied address, routed remote office, WAN, VPN or wider subnet.
    ips = [str(ip) for net in networks for ip in ipaddress.ip_network(net).hosts()]
    deadline = time.monotonic() + 18
    rows, attempted_count, completed = [], 0, 0
    def probe(ip):
        if time.monotonic() >= deadline:
            return False, False, None
        finished, row = printer_host(ip, deadline)
        return True, finished, row
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
        for attempted, finished, row in pool.map(probe, ips):
            attempted_count += int(attempted)
            completed += int(finished)
            if row:
                rows.append(row)
    return {'available': True, 'networks': networks, 'ports': [631, 9100, 515],
            'hostsAttempted': attempted_count, 'hostsCompleted': completed, 'hostsTotal': len(ips), 'scanComplete': completed == len(ips),
            **bounded_rows(sorted(rows, key=lambda row: ipaddress.ip_address(row['ip']))),
            'limitations': ['An open printing port is a candidate, not a confirmed device model.',
                            'USB, sleeping, firewalled or differently configured printers may be absent.',
                            'IPP model/name/location are untrusted self-reported device attributes.']}

def smb(gateway):
    if gateway != 'nsk':
        return {'available': False, 'reason': 'NOT_CONFIGURED'}
    values = {}
    for section, parameters in [('global', ['map to guest', 'server signing', 'server min protocol', 'server max protocol']),
                                ('files_nsk', ['guest ok', 'read only'])]:
        for parameter in parameters:
            try:
                values[section + '.' + parameter] = clean(command(
                    ['testparm', '-s', '--section-name=' + section, '--parameter-name=' + parameter]).strip(), 100)
            except (ValueError, OSError, subprocess.SubprocessError):
                values[section + '.' + parameter] = None
    return {'available': any(v is not None for v in values.values()), 'parameters': values,
            'limitations': ['Server configuration does not establish client Windows policies or effective user permissions.']}

def collect(gateway, kind):
    if gateway not in NETWORKS or kind not in ('dhcp', 'devices', 'printers', 'smb'):
        raise ValueError('INVALID_FIXED_OPERATION')
    if kind == 'smb':
        return {'smb': smb(gateway)}
    networks = verified_networks(gateway, json.loads(command(['ip', '-j', '-4', 'address'])))
    if not networks:
        return {'discovery': {'available': False, 'reason': 'VERIFIED_LAN_UNAVAILABLE'}}
    if kind == 'printers':
        return {'printers': printers(networks)}
    result = {'networks': networks, 'dhcp': dhcp(gateway, networks)}
    if kind == 'devices':
        result['neighbours'] = neighbours(networks)
    return result
