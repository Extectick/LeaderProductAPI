#!/usr/bin/python3
"""Root-owned fixed source command. Only sanitized dialogue/public capability metadata leave it."""
import datetime,json,re,subprocess,sys
from pathlib import Path

def public_runtime(container, formats=None):
 env=dict(value.split('=',1) for value in container.get('Config',{}).get('Env',[]) if '=' in value)
 image=container.get('Image','');model=env.get('HELP_OPENAI_MODEL','');provider=env.get('HELP_AI_PROVIDER','')
 if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):return {'known':False}
 return {'known':True,'imageDigest':image,'model':model if re.fullmatch(r'gpt-[a-z0-9._-]{1,64}',model) else None,
  'provider':provider if provider in ['openai','t3','bunny','knowledge','simulator','disabled'] else None,
  'reasoningEffort':env.get('HELP_OPENAI_REASONING_EFFORT') if env.get('HELP_OPENAI_REASONING_EFFORT') in ['low','medium','high','xhigh','max'] else None,
  'fileFormatsKnown':formats is not None,'fileFormats':sorted(set(value for value in (formats or []) if value in ['txt','md','csv','json'])),
  'snapshotImageBytes':False,'snapshotToolResultBodies':False,
  'observedAt':int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000)}

def runtime_metadata():
 try:
  result=subprocess.run(['docker','inspect','leader_api_dev'],capture_output=True,timeout=10,check=True)
  container=json.loads(result.stdout)[0]
  probe="const {validateHelpAIFiles:v}=require('./dist/modules/help/help.ai-file-contract');const a=[];for(const ext of ['txt','md','csv','json']){try{v([{name:'fixture.'+ext,content:ext==='json'?'{}':'fixture'}]);a.push(ext)}catch{}}console.log(JSON.stringify(a))"
  reply=subprocess.run(['docker','exec','leader_api_dev','node','-e',probe],capture_output=True,timeout=10)
  formats=json.loads(reply.stdout) if reply.returncode==0 and len(reply.stdout)<1024 else None
  return public_runtime(container,formats if isinstance(formats,list) else None)
 except Exception:return {'known':False}

def main():
 try:
  payload=sys.stdin.buffer.read(8193)
  if not payload or len(payload)>8192:raise ValueError()
  config=json.loads(Path('/opt/leader-help-learning-dev/runtime.private.json').read_text())
  args=['docker','run','--rm','-i','--read-only','--log-driver','none','--network','leader-api-dev_default','--memory','256m','--cpus','0.25','--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges:true','--env-file',config['environmentFile'],'--entrypoint','node',config['image'],'/app/scripts/help-learning/source.cjs']
  result=subprocess.run(args,input=payload,capture_output=True,timeout=75)
  if result.returncode or len(result.stdout)>2097152:raise RuntimeError()
  response=json.loads(result.stdout);response['runtimeCapabilities']=runtime_metadata()
  output=(json.dumps(response,ensure_ascii=False)+'\n').encode()
  if len(output)>2097152:raise RuntimeError()
  sys.stdout.buffer.write(output)
 except Exception:
  sys.stderr.write('{"ok":false,"code":"HELP_LEARNING_SOURCE_UNAVAILABLE"}\n');return 1
 return 0
if __name__=='__main__':sys.exit(main())
