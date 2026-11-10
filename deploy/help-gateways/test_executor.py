import importlib.util,json,subprocess,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('gateway_executor',Path(__file__).with_name('executor.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class ExecutorTests(unittest.TestCase):
 def test_only_read_commands(self):
  for gateway in mod.TARGETS:
   for kind in mod.KINDS:
    for argv in mod.commands(gateway,kind).values():
     self.assertIsInstance(argv,list);self.assertNotIn('sh',argv);self.assertNotIn('bash',argv);self.assertNotIn('restart',argv);self.assertNotIn('rm',argv)
 def test_keys_and_commands_are_not_in_response(self):
  with patch.object(mod.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout='{"hostname":{"data":"serverlp"}}')) as run:
   result=mod.diagnose('omsk','overview');self.assertTrue(result['ok']);self.assertEqual(result['endpoint'],'95.80.103.205')
   argv=run.call_args.args[0];self.assertIn('StrictHostKeyChecking=yes',argv);self.assertIn('BatchMode=yes',argv);self.assertFalse('key' in json.dumps(result).lower())
 def test_second_wan_fallback(self):
  with patch.object(mod.subprocess,'run',side_effect=[subprocess.CompletedProcess([],255,stdout=''),subprocess.CompletedProcess([],0,stdout='{}')]) as run:
   result=mod.diagnose('omsk','network');self.assertEqual(result['endpoint'],'91.144.170.136');self.assertEqual(run.call_count,2)
 def test_error_does_not_publish_ssh_stderr(self):
  with patch.object(mod.subprocess,'run',return_value=subprocess.CompletedProcess([],255,stdout='',stderr='private diagnostic')):
   result=mod.diagnose('nsk','vpn');self.assertEqual(result['error'],'GATEWAY_UNAVAILABLE');self.assertNotIn('private',json.dumps(result))
if __name__=='__main__':unittest.main()
