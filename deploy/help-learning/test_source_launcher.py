import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('launcher',Path(__file__).with_name('source-launcher.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class MetadataTests(unittest.TestCase):
 def test_whitelist_excludes_private_configuration(self):
  fixture={'Image':'sha256:'+'a'*64,'Config':{'Env':['HELP_AI_PROVIDER=openai','HELP_OPENAI_MODEL=gpt-6.1-sol','HELP_OPENAI_REASONING_EFFORT=medium','OPENAI_API_KEY=synthetic-private','DATABASE_URL=synthetic-private','HELP_T3_WEBHOOK_URL=synthetic-private']}}
  result=module.public_runtime(fixture,['txt','json','json','docx']);self.assertEqual(result['fileFormats'],['docx','json','txt']);self.assertEqual(result['model'],'gpt-6.1-sol');self.assertNotIn('synthetic-private',json.dumps(result));self.assertFalse(result['snapshotImageBytes'])
 def test_unverified_formats_remain_unknown(self):
  result=module.public_runtime({'Image':'sha256:'+'b'*64,'Config':{'Env':['HELP_OPENAI_MODEL=synthetic-secret-token']}},None);self.assertFalse(result['fileFormatsKnown']);self.assertIsNone(result['model'])
 def test_invalid_image_is_unknown(self):self.assertEqual(module.public_runtime({'Image':'unexpected'}),{'known':False})

class OfficeMetadataTests(unittest.TestCase):
 def test_six_formats_are_allowed_only_as_public_metadata(self):
  result=module.public_runtime({'Image':'sha256:'+'c'*64,'Config':{'Env':[]}},['txt','md','csv','json','xlsx','docx','exe','PRIVATE'],True)
  self.assertEqual(result['fileFormats'],['csv','docx','json','md','txt','xlsx']);self.assertTrue(result['officeFormatsKnown']);self.assertTrue(result['fileFormatsKnown']);self.assertNotIn('PRIVATE',json.dumps(result))
 def test_failed_office_probe_is_unknown_not_an_assertion_of_no_office_support(self):
  result=module.public_runtime({'Image':'sha256:'+'d'*64,'Config':{'Env':[]}},['txt'],False)
  self.assertFalse(result['fileFormatsKnown']);self.assertFalse(result['officeFormatsKnown'])

class EvidenceTests(unittest.TestCase):
 def snapshot(self):return {'ticketId':63,'sourceVersion':'a'*64,'messages':[{'id':1132}]}
 def evidence(self):return {'schemaVersion':1,'tickets':[{'ticketId':63,'analysisEvidence':{'version':1,'files':[{'messageId':1132,'sha256':'b'*64,'headers':['Value']}],'toolCalls':[],'filesTruncated':False,'toolsTruncated':False}}]}
 def test_version_includes_actual_file_contents_and_is_stable(self):
  a=module.attach_evidence({'snapshots':[self.snapshot()]},self.evidence())['snapshots'][0]
  b=module.attach_evidence({'snapshots':[self.snapshot()]},self.evidence())['snapshots'][0]
  self.assertEqual(a['sourceVersion'],b['sourceVersion']);self.assertEqual(a['projectionVersion'],4)
  changed=self.evidence();changed['tickets'][0]['analysisEvidence']['files'][0]['headers']=['Other']
  c=module.attach_evidence({'snapshots':[self.snapshot()]},changed)['snapshots'][0]
  self.assertNotEqual(a['sourceVersion'],c['sourceVersion'])
 def test_revoke_between_snapshot_and_collector_drops_ticket(self):
  self.assertEqual(module.attach_evidence({'snapshots':[self.snapshot()]},{'schemaVersion':1,'tickets':[]})['snapshots'],[])
 def test_unbound_message_or_ticket_is_rejected(self):
  for field,value in [('messageId',999),('ticketId',999)]:
   data=self.evidence()
   if field=='messageId':data['tickets'][0]['analysisEvidence']['files'][0][field]=value
   else:data['tickets'][0][field]=value
   with self.assertRaises(ValueError):module.attach_evidence({'snapshots':[self.snapshot()]},data)

if __name__=='__main__':unittest.main()
