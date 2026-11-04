#!/usr/bin/env python3
"""Scoped dev-only installation: minimal PostgreSQL reader views and forced SSH command."""
import datetime,fcntl,json,os,subprocess,secrets,pwd
from pathlib import Path
from urllib.parse import urlsplit,urlunsplit,quote
os.umask(0o077)
root=Path('/opt/leader-help-learning-dev');workspace=Path('/opt/leader-metro-dev/workspace')
reader='leader_help_learning_ro';marker='leader-help-learning-source-v1'
def run(args,data=None,timeout=60):
 p=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
 if p.returncode:raise RuntimeError('Installation command failed: '+' '.join(args[:2]))
 return p.stdout

def private(path,data):
 temp=path.with_suffix('.tmp');temp.write_bytes(data);temp.chmod(0o600);temp.replace(path)
def main():
 assert run(['hostname']).strip()==b'docker-01','Wrong host'
 root.mkdir(mode=0o700,exist_ok=True)
 with (root/'install.lock').open('a+') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  api=json.loads(run(['docker','inspect','leader_api_dev']))[0]
  env=dict(v.split('=',1) for v in api['Config']['Env']);u=urlsplit(env['DATABASE_URL'])
  assert u.path=='/LeaderAPI_dev' and env['NODE_ENV']=='development' and env['DB_ACCEPT_DATA_LOSS']=='0','Wrong target'
  assert 'leader-api-dev_default' in api['NetworkSettings']['Networks'],'Wrong network'
  pg=json.loads(run(['docker','inspect','leader_postgres_dev']))[0];pgEnv=dict(v.split('=',1) for v in pg['Config']['Env']);pgUser=pgEnv['POSTGRES_USER']
  role=run(['docker','exec','leader_postgres_dev','psql','-X','-At','-U',pgUser,'-d','LeaderAPI_dev','-c',"SELECT COALESCE(shobj_description(oid,'pg_authid'),'') FROM pg_roles WHERE rolname='leader_help_learning_ro'"]).decode().strip()
  exists=run(['docker','exec','leader_postgres_dev','psql','-X','-At','-U',pgUser,'-d','LeaderAPI_dev','-c',"SELECT count(*) FROM pg_roles WHERE rolname='leader_help_learning_ro'"]).strip()==b'1'
  assert not exists or role==marker,'Existing role is not owned by this installation'
  schemaOwner=run(['docker','exec','leader_postgres_dev','psql','-X','-At','-U',pgUser,'-d','LeaderAPI_dev','-c',"SELECT COALESCE(obj_description(oid,'pg_namespace'),'') FROM pg_namespace WHERE nspname='help_learning'"]).decode().strip()
  schemaExists=run(['docker','exec','leader_postgres_dev','psql','-X','-At','-U',pgUser,'-d','LeaderAPI_dev','-c',"SELECT count(*) FROM pg_namespace WHERE nspname='help_learning'"]).strip()==b'1'
  assert not schemaExists or schemaOwner==marker or role==marker,'Existing schema is not managed by this installation'
  stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');backup=root/'backups'/stamp;backup.mkdir(parents=True,mode=0o700)
  for name in ['source.private.env','runtime.private.json']:
   if (root/name).exists():private(backup/name,(root/name).read_bytes())
  schema=(workspace/'.dev-runtime/help-learning-source-image/source-schema.sql').read_bytes()
  password=secrets.token_urlsafe(48)
  # Session logging disabled before setting the generated password. Neither SQL
  # nor provider errors are emitted to the user's transcript or runtime logs.
  setup=b"SET log_statement='none'; SET log_min_error_statement='panic'; SET log_parameter_max_length_on_error=0;\n"+schema
  setup+=("\nALTER ROLE leader_help_learning_ro LOGIN PASSWORD '"+password+"';\nCOMMENT ON SCHEMA help_learning IS '"+marker+"';\nCOMMENT ON ROLE leader_help_learning_ro IS '"+marker+"';\nGRANT CONNECT ON DATABASE \"LeaderAPI_dev\" TO leader_help_learning_ro;\n").encode()
  run(['docker','exec','-i','leader_postgres_dev','psql','-X','-v','ON_ERROR_STOP=1','-U',pgUser,'-d','LeaderAPI_dev'],setup)
  netloc=quote(reader,safe='')+':'+quote(password,safe='')+'@'+u.hostname+(':'+str(u.port) if u.port else '')
  readUrl=urlunsplit((u.scheme,netloc,u.path,u.query,''))
  assert '\n' not in readUrl and '\r' not in readUrl
  private(root/'source.private.env',('HELP_LEARNING_TARGET=dev\nHELP_LEARNING_DATABASE_URL='+readUrl+'\n').encode())
  image='leaderproductapi:help-learning-source-dev-20261105'
  imageId=json.loads(run(['docker','image','inspect',image]))[0]['Id']
  private(root/'runtime.private.json',json.dumps({'image':imageId,'environmentFile':str(root/'source.private.env')}).encode())
  helper=Path('/usr/local/libexec/leader-help-learning-source');helper.parent.mkdir(parents=True,exist_ok=True)
  helper.write_text('''#!/usr/bin/python3
import json,subprocess,sys
from pathlib import Path
try:
 payload=sys.stdin.buffer.read(8193)
 if not payload or len(payload)>8192:raise ValueError()
 config=json.loads(Path('/opt/leader-help-learning-dev/runtime.private.json').read_text())
 args=['docker','run','--rm','-i','--read-only','--log-driver','none','--network','leader-api-dev_default','--memory','256m','--cpus','0.25','--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges:true','--env-file',config['environmentFile'],'--entrypoint','node',config['image'],'/app/scripts/help-learning/source.cjs']
 result=subprocess.run(args,input=payload,capture_output=True,timeout=75)
 if result.returncode or len(result.stdout)>2097152:raise RuntimeError()
 sys.stdout.buffer.write(result.stdout)
except Exception:
 sys.stderr.write('{"ok":false,"code":"HELP_LEARNING_SOURCE_UNAVAILABLE"}\\n');sys.exit(1)
''');helper.chmod(0o755)
  gateway=Path('/usr/local/bin/leader-help-learning-source-gateway')
  gateway.write_text('''#!/usr/bin/python3
import os,sys
if os.environ.get('SSH_ORIGINAL_COMMAND')!='help-learning-source-v1':
 sys.stderr.write('Restricted Help source command required\\n');sys.exit(1)
os.execv('/usr/bin/sudo',['sudo','-n','--','/usr/local/libexec/leader-help-learning-source'])
''');gateway.chmod(0o755)
  sudoers=Path('/etc/sudoers.d/leader-help-learning-source')
  sudoers.write_text('# '+marker+'\nextectick ALL=(root) NOPASSWD: /usr/local/libexec/leader-help-learning-source ""\n');sudoers.chmod(0o440)
  run(['visudo','-cf',str(sudoers)])
  account=pwd.getpwnam('extectick');sshdir=Path(account.pw_dir)/'.ssh';sshdir.mkdir(mode=0o700,exist_ok=True)
  authorized=sshdir/'authorized_keys';old=authorized.read_text() if authorized.exists() else ''
  pub=(workspace/'.dev-runtime/help-learning-implementation/source-key.pub').read_text().strip()
  assert pub.startswith('ssh-ed25519 ') and '\n' not in pub,'Invalid dedicated key'
  entry='restrict,command="/usr/local/bin/leader-help-learning-source-gateway" '+pub
  if entry not in old:
   authorized.write_text(old.rstrip('\n')+'\n'+entry+'\n');authorized.chmod(0o600);os.chown(authorized,account.pw_uid,account.pw_gid)
  os.chown(sshdir,account.pw_uid,account.pw_gid)
  proof={'installed':True,'database':'LeaderAPI_dev','readerRole':reader,'sourceImage':imageId,'forcedSshCommand':True,'noApiRestart':True,'backup':str(backup)}
  private(root/'installation-proof.json',json.dumps(proof,indent=2).encode());print(json.dumps(proof))
if __name__=='__main__':
 try:main()
 except Exception as error:
  print('Help learning source installation stopped: '+(str(error) if isinstance(error,(AssertionError,RuntimeError)) else type(error).__name__));raise SystemExit(1)
