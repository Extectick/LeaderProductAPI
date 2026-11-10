import importlib.util
import json
import struct
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('discovery', Path(__file__).with_name('discovery.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class DiscoveryTests(unittest.TestCase):
    def test_scan_requires_allowlist_and_current_connected_network(self):
        interfaces = [{'flags': ['UP'], 'addr_info': [
            {'family': 'inet', 'local': '192.168.30.1', 'prefixlen': 24},
            {'family': 'inet', 'local': '10.0.0.1', 'prefixlen': 24},
            {'family': 'inet', 'local': '192.168.20.1', 'prefixlen': 16}]},
            {'flags': [], 'addr_info': [{'family': 'inet', 'local': '192.168.20.1', 'prefixlen': 24}]}]
        self.assertEqual(mod.verified_networks('nsk', interfaces), ['192.168.30.0/24'])
        self.assertEqual(mod.verified_networks('omsk', interfaces), [])
        with patch.object(mod, 'command', return_value='[]'), patch.object(mod, 'printers') as scan:
            self.assertEqual(mod.collect('nsk', 'printers')['discovery']['reason'], 'VERIFIED_LAN_UNAVAILABLE')
            scan.assert_not_called()

    def test_dhcp_projects_fields_and_uses_last_lease(self):
        text = '''lease 192.168.30.20 { hardware ethernet aa:bb:cc:dd:ee:ff; client-hostname "printer"; binding state active; uid "PRIVATE"; }
lease 192.168.30.20 { binding state free; ends 1 2026/11/09 00:00:00; }
lease 8.8.8.8 { binding state active; }
lease 192.168.30.255 { binding state active; }'''
        value = mod.isc_leases(text, ['192.168.30.0/24'])
        self.assertEqual(value, [{'ip': '192.168.30.20', 'state': 'free', 'ends': '1 2026/11/09 00:00:00'}])
        self.assertNotIn('PRIVATE', json.dumps(value))
        config = 'key private { secret "SECRET"; } host PRINTER { hardware ethernet aa:bb:cc:dd:ee:ff; fixed-address 192.168.30.22, 9.9.9.9; option secret "HIDDEN"; }'
        self.assertEqual(mod.isc_reservations(config, ['192.168.30.0/24']),
                         [{'ip': '192.168.30.22', 'hostname': 'PRINTER', 'mac': 'aa:bb:cc:dd:ee:ff'}])

    def test_missing_dhcp_is_unknown_not_empty(self):
        with patch.object(mod, 'read_fixed', side_effect=PermissionError):
            value = mod.dhcp('nsk', ['192.168.30.0/24'])
        self.assertFalse(value['leases']['available'])
        self.assertNotIn('rows', value['leases'])

    def test_legacy_ip_neighbour_text_is_supported_without_raw_output(self):
        text = '192.168.30.5 dev enp2s0 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n8.8.8.8 dev wan FAILED\n192.168.30.6 dev enp2s0 FAILED\n'
        with patch.object(mod, 'command', return_value=text):
            value = mod.neighbours(['192.168.30.0/24'])
        self.assertTrue(value['available'])
        self.assertEqual(value['totalRows'], 2)
        self.assertEqual(value['rows'][0]['state'], ['REACHABLE'])

    def test_no_user_targets_and_only_print_ports(self):
        conn = MagicMock()
        with patch.object(mod.socket, 'create_connection', return_value=conn) as connect, patch.object(mod, 'ipp_attributes', return_value={}):
            finished, row = mod.printer_host('192.168.30.10', time.monotonic()+3)
        self.assertTrue(finished)
        self.assertEqual(row['identification'], 'printer_port_candidate')
        self.assertEqual([call.args[0] for call in connect.call_args_list], [('192.168.30.10', 631), ('192.168.30.10', 9100), ('192.168.30.10', 515)])
        conn.__enter__.return_value.send.assert_not_called()
        with self.assertRaises(ValueError): mod.collect('8.8.8.8', 'printers')
        with self.assertRaises(ValueError): mod.collect('nsk', 'shell')

    def test_printer_completion_reports_timeout(self):
        with patch.object(mod, 'printer_host', return_value=(False, None)):
            value = mod.printers(['192.168.30.0/30'])
        self.assertFalse(value['scanComplete'])
        self.assertEqual(value['hostsAttempted'], 2)
        self.assertEqual(value['hostsCompleted'], 0)

    def test_ipp_is_read_only_and_projects_model(self):
        name = b'printer-make-and-model'; value = b'Example Laser'
        data = b'\x01\x01\x00\x00\x00\x00\x00\x01\x04\x41' + struct.pack('!H',len(name))+name+struct.pack('!H',len(value))+value+b'\x03'
        conn = MagicMock(); response = conn.getresponse.return_value
        response.status = 200; response.read.return_value = data
        with patch.object(mod.http.client, 'HTTPConnection', return_value=conn):
            result = mod.ipp_attributes('192.168.30.5')
        self.assertEqual(result, {'model': 'Example Laser'})
        request = conn.request.call_args.args
        self.assertEqual(request[:2], ('POST', '/ipp/print'))
        self.assertEqual(request[2][2:4], b'\x00\x0b')
        self.assertNotIn(b'Print-Job', request[2])
        conn.close.assert_called_once()

    def test_smb_reads_only_allowlisted_parameters(self):
        with patch.object(mod, 'command', return_value='Yes') as run:
            value = mod.smb('nsk')
        self.assertEqual(len(value['parameters']), 6)
        for call in run.call_args_list:
            args = call.args[0]
            self.assertEqual(args[:2], ['testparm', '-s'])
            self.assertTrue(args[-1].startswith('--parameter-name='))

if __name__ == '__main__': unittest.main()
