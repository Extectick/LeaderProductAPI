#!/usr/bin/python3
"""Private Unix-socket gateway diagnostics. No user supplied shell commands."""
import datetime,http.server,socketserver,threading,subprocess,json,os,time
from pathlib import Path
ROOT=Path.home()/'.local/share/leader-help-gateways'
SOCKET='/opt/leader-api-dev/gateway-runtime/control.sock'
TARGETS={'nsk':('kirill','nsk_ed25519',['192.168.30.1']), 'omsk':('liderprod','omsk_ed25519',['95.80.103.205','91.144.170.136'])}
KINDS={'overview','network','vpn','files','services','dhcp','devices','printers','smb'}
DISCOVERY_KINDS={'dhcp','devices','printers','smb'}
LIMIT=threading.BoundedSemaphore(2)
def commands(gateway,kind):
 result={'hostname':['hostname'],'clock':['date','-u','+%Y-%m-%dT%H:%M:%SZ']}
 if kind in {'overview','network','vpn'}:
  result.update(addresses=['ip','-j','-4','address'],routes=['ip','-j','-4','route','show'],rules=['ip','-j','rule'])
 if kind=='network' and gateway=='omsk':result.update(prostorRoutes=['ip','-j','-4','route','show','table','101'],domruRoutes=['ip','-j','-4','route','show','table','102'])
 if kind in {'overview','services','vpn'}:
  names=['openvpn@server','wg-quick@wg-nsk','smbd','nmbd','isc-dhcp-server','bareos-director','bareos-storage','bareos-filedaemon','squid','vsftpd','webmin','zabbix-agent'] if gateway=='nsk' else ['openvpn-client@omsk','omsk-pppoe','omsk-wan-watch','kea-dhcp4-server','webmin','ssh']
  result['services']=['systemctl','show','--property=Id,ActiveState,SubState',*names]
 if kind in {'overview','files'}:
  result['disk']=['df','-hT','/mnt/samba','/mnt/backup'] if gateway=='nsk' else ['df','-hT','/']
  if gateway=='nsk':result.update(inodes=['df','-i','/mnt/samba','/mnt/backup'],shares=['stat','-c','%a %U:%G %n','/mnt/samba/files_nsk','/mnt/samba/scan'])
 if kind=='vpn' and gateway=='nsk':result['wireguardHandshakes']=['sudo','-n','wg','show','wg-nsk','latest-handshakes']
 if kind=='services':result['listeners']=['ss','-lntu']
 return result
REMOTE='''import subprocess,json
commands=COMMANDS
results={}
for name,args in commands.items():
 try:
  p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,universal_newlines=True,timeout=4)
  text=p.stdout[:20000]
  try:data=json.loads(text)
  except Exception:data=text
  results[name]={'available':p.returncode==0,'data':data,'exitCode':p.returncode}
 except Exception:results[name]={'available':False,'reason':'UNAVAILABLE'}
print(json.dumps(results))
'''
def diagnose(gateway,kind):
 if gateway not in TARGETS or kind not in KINDS:return {'ok':False,'error':'GATEWAY_ARGUMENTS'}
 user,key,endpoints=TARGETS[gateway]
 program=(Path(__file__).with_name('discovery.py').read_text()+'\nprint(json.dumps(collect('+repr(gateway)+','+repr(kind)+')))\n') if kind in DISCOVERY_KINDS else REMOTE.replace('COMMANDS',repr(commands(gateway,kind)))
 for endpoint in endpoints:
  argv=['/usr/bin/ssh','-F','/dev/null','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','ConnectTimeout=6','-o','ConnectionAttempts=1','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=1','-o','UserKnownHostsFile='+str(ROOT/'known_hosts'),'-i',str(ROOT/key),user+'@'+endpoint,'python3 -']
  try:
   p=subprocess.run(argv,input=program,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,universal_newlines=True,timeout=30 if kind in DISCOVERY_KINDS else 21)
   if p.returncode==0 and len(p.stdout.encode())<120000:
    return {'ok':True,'gateway':gateway,'kind':kind,'endpoint':endpoint,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':json.loads(p.stdout)}
   if p.returncode!=255:break
  except (subprocess.TimeoutExpired,ValueError,OSError):continue
 return {'ok':False,'gateway':gateway,'error':'GATEWAY_UNAVAILABLE'}
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def answer(self,status,value):
  data=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers()
  try:self.wfile.write(data)
  except (BrokenPipeError,ConnectionResetError):pass
 def do_POST(self):
  try:
   size=int(self.headers.get('Content-Length','0'))
   if self.path!='/diagnose' or size<1 or size>1024:return self.answer(400,{'ok':False,'error':'GATEWAY_ARGUMENTS'})
   data=json.loads(self.rfile.read(size))
   if not isinstance(data,dict) or set(data)!={'gateway','kind'} or data['gateway'] not in TARGETS or data['kind'] not in KINDS:return self.answer(400,{'ok':False,'error':'GATEWAY_ARGUMENTS'})
   if not LIMIT.acquire(blocking=False):return self.answer(429,{'ok':False,'error':'GATEWAY_BUSY'})
   try:
    start=time.monotonic();result=diagnose(data['gateway'],data['kind'])
    print(json.dumps({'gateway':data['gateway'],'kind':data['kind'],'ok':result['ok'],'durationMs':round((time.monotonic()-start)*1000)}),flush=True)
    return self.answer(200 if result['ok'] else 503,result)
   finally:LIMIT.release()
  except Exception:self.answer(400,{'ok':False,'error':'GATEWAY_ARGUMENTS'})
class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):daemon_threads=True
if __name__=='__main__':
 if os.path.exists(SOCKET):os.unlink(SOCKET)
 with Server(SOCKET,Handler) as server:
  os.chmod(SOCKET,0o660);server.serve_forever()
