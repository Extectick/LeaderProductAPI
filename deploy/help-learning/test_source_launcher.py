import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('launcher',Path(__file__).with_name('source-launcher.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class MetadataTests(unittest.TestCase):
 def test_whitelist_excludes_private_configuration(self):
  fixture={'Image':'sha256:'+'a'*64,'Config':{'Env':['HELP_AI_PROVIDER=openai','HELP_OPENAI_MODEL=gpt-6.1-sol','HELP_OPENAI_REASONING_EFFORT=medium','OPENAI_API_KEY=synthetic-private','DATABASE_URL=synthetic-private','HELP_T3_WEBHOOK_URL=synthetic-private']}}
  result=module.public_runtime(fixture,['txt','json','json','docx']);self.assertEqual(result['fileFormats'],['json','txt']);self.assertEqual(result['model'],'gpt-6.1-sol');self.assertNotIn('synthetic-private',json.dumps(result));self.assertFalse(result['snapshotImageBytes'])
 def test_unverified_formats_remain_unknown(self):
  result=module.public_runtime({'Image':'sha256:'+'b'*64,'Config':{'Env':['HELP_OPENAI_MODEL=synthetic-secret-token']}},None);self.assertFalse(result['fileFormatsKnown']);self.assertIsNone(result['model'])
 def test_invalid_image_is_unknown(self):self.assertEqual(module.public_runtime({'Image':'unexpected'}),{'known':False})
if __name__=='__main__':unittest.main()
