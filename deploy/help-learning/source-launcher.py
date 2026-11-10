#!/usr/bin/python3
"""Root-owned source + fixed, read-only artifact collector. Inference gets no tools."""
import datetime,hashlib,json,re,subprocess,sys
from pathlib import Path

def public_runtime(container, formats=None, office_known=None):
 env=dict(value.split('=',1) for value in container.get('Config',{}).get('Env',[]) if '=' in value)
 image=container.get('Image','');model=env.get('HELP_OPENAI_MODEL','');provider=env.get('HELP_AI_PROVIDER','')
 if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):return {'known':False}
 return {'known':True,'imageDigest':image,'model':model if re.fullmatch(r'gpt-[a-z0-9._-]{1,64}',model) else None,
  'provider':provider if provider in ['openai','t3','bunny','knowledge','simulator','disabled'] else None,
  'reasoningEffort':env.get('HELP_OPENAI_REASONING_EFFORT') if env.get('HELP_OPENAI_REASONING_EFFORT') in ['low','medium','high','xhigh','max'] else None,
  'fileFormatsKnown':formats is not None and office_known is not False,'officeFormatsKnown':office_known is True,
  'fileFormats':sorted(set(value for value in (formats or []) if value in ['txt','md','csv','json','xlsx','docx'])),
  'snapshotImageBytes':False,'snapshotToolResultBodies':True,'snapshotArtifactContents':True,
  'observedAt':int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000)}

# The fixed probe uses only synthetic in-memory data. It never queries the DB,
# model, 1C or object storage, and never persists the generated fixture bytes.
CAPABILITY_PROBE = r"""
(async()=>{
 const formats=[];let officeKnown=true;
 if(process.env.HELP_AI_PROVIDER!=='openai'){console.log(JSON.stringify({formats,officeKnown:false}));return;}
 const {validateHelpAIFiles:v}=require('./dist/modules/help/help.ai-file-contract');
 for(const ext of ['txt','md','csv','json']){try{v([{name:'fixture.'+ext,content:ext==='json'?'{}':'fixture'}]);formats.push(ext)}catch{}}
 try{
  const wrapper=require('fs').readFileSync(require.resolve('./dist/modules/help/help.openai-answer'),'utf8');
  if(wrapper.includes('helpOfficeTools')){
   const t=require('./dist/modules/help/help.office-tools').helpOfficeTools();
   const cases=[['xlsx','help_create_spreadsheet',{name:'fixture.xlsx',sheets:[{name:'Probe',headers:['Value'],rows:[[1]]}]}],
    ['docx','help_create_document',{name:'fixture.docx',blocks:[{type:'paragraph',text:'fixture'}]}]];
   for(const [ext,name,args] of cases){
    const result=JSON.parse(await t.call(name,args,AbortSignal.timeout(3000)));
    const file=t.files.find(f=>f.name==='fixture.'+ext);
    if(!result.created||!file||!Buffer.isBuffer(file.bytes)||!file.bytes.subarray(0,4).equals(Buffer.from([80,75,3,4])))throw Error('PROBE_FAILED');
    formats.push(ext);
   }
  }
 }catch{officeKnown=false;}
 console.log(JSON.stringify({formats,officeKnown}));
})().catch(()=>process.exitCode=1);
"""
def runtime_metadata():
 try:
  result=subprocess.run(['docker','inspect','leader_api_dev'],capture_output=True,timeout=10,check=True)
  container=json.loads(result.stdout)[0]
  reply=subprocess.run(['docker','exec','leader_api_dev','node','-e',CAPABILITY_PROBE],capture_output=True,timeout=10)
  probe=json.loads(reply.stdout) if reply.returncode==0 and len(reply.stdout)<1024 else None
  if not isinstance(probe,dict) or not isinstance(probe.get('formats'),list) or not isinstance(probe.get('officeKnown'),bool):return public_runtime(container)
  return public_runtime(container,probe['formats'],probe['officeKnown'])
 except Exception:return {'known':False}

def attach_evidence(response, evidence):
 if not isinstance(response,dict) or not isinstance(response.get('snapshots'),list):raise ValueError()
 if not isinstance(evidence,dict) or evidence.get('schemaVersion')!=1 or not isinstance(evidence.get('tickets'),list):raise ValueError()
 snapshots=response['snapshots'];requested={s['ticketId']:s for s in snapshots}
 if len(requested)!=len(snapshots) or len(requested)>20:raise ValueError()
 returned={}
 for item in evidence['tickets']:
  ticket_id=item.get('ticketId');data=item.get('analysisEvidence')
  if ticket_id not in requested or ticket_id in returned or not isinstance(data,dict) or data.get('version')!=1:raise ValueError()
  ids={m['id'] for m in requested[ticket_id]['messages']}
  for field in ['files','toolCalls']:
   if not isinstance(data.get(field),list) or any(e.get('messageId') not in ids for e in data[field]):raise ValueError()
  returned[ticket_id]=data
 # Eligibility can be revoked between the source snapshot and the collector.
 # Drop that snapshot entirely; the runner treats it as revoked on recheck.
 response['snapshots']=[s for s in snapshots if s['ticketId'] in returned]
 for snapshot in response['snapshots']:
  data=returned[snapshot['ticketId']]
  version={'projectionVersion':4,'sourceVersion':snapshot['sourceVersion'],'analysisEvidence':data}
  snapshot['sourceVersion']=hashlib.sha256(json.dumps(version,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
  snapshot['projectionVersion']=4;snapshot['analysisEvidence']=data
 return response

def collect_evidence(response):
 tickets=[{'ticketId':s['ticketId'],'messageIds':[m['id'] for m in s['messages']]} for s in response.get('snapshots',[])]
 if not tickets:return attach_evidence(response,{'schemaVersion':1,'tickets':[]})
 payload=json.dumps({'tickets':tickets},separators=(',',':')).encode()
 # This is a fixed trusted command. API credentials remain inside the existing
 # dev container; SQL is READ ONLY and the isolated model never sees credentials.
 result=subprocess.run(['docker','exec','-i','leader_api_dev','node','/app/scripts/help-learning/evidence-reader.cjs'],input=payload,capture_output=True,timeout=75)
 if result.returncode or len(result.stdout)>4194304:raise RuntimeError()
 return attach_evidence(response,json.loads(result.stdout))

def main():
 try:
  payload=sys.stdin.buffer.read(8193)
  if not payload or len(payload)>8192:raise ValueError()
  config=json.loads(Path('/opt/leader-help-learning-dev/runtime.private.json').read_text())
  args=['docker','run','--rm','-i','--read-only','--log-driver','none','--network','leader-api-dev_default','--memory','256m','--cpus','0.25','--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges:true','--env-file',config['environmentFile'],'--entrypoint','node',config['image'],'/app/scripts/help-learning/source.cjs']
  result=subprocess.run(args,input=payload,capture_output=True,timeout=75)
  if result.returncode or len(result.stdout)>2097152:raise RuntimeError()
  response=collect_evidence(json.loads(result.stdout));response['runtimeCapabilities']=runtime_metadata()
  output=(json.dumps(response,ensure_ascii=False)+'\n').encode()
  if len(output)>8388608:raise RuntimeError()
  sys.stdout.buffer.write(output)
 except Exception:
  sys.stderr.write('{"ok":false,"code":"HELP_LEARNING_SOURCE_UNAVAILABLE"}\n');return 1
 return 0
if __name__=='__main__':sys.exit(main())
