import hashlib,json,shutil,subprocess
from pathlib import Path
r=Path('/home/extectick/LeaderProduct');src=r/'LeaderProductAPI/scripts/help-learning';out=r/'.dev-runtime/help-learning-source-image';out.mkdir(mode=0o700,exist_ok=True)
for n in ['source.cjs','privacy.cjs','source-schema.sql']:shutil.copy2(src/n,out/n)
raw=subprocess.check_output(['ssh','leader-126','docker','inspect','leader_api_dev'],text=True);c=json.loads(raw)[0]
base=c['Config']['Image'];assert base.startswith('leaderproductapi:help-')
(out/'Dockerfile').write_text('FROM '+base+'\nCOPY --chown=10001:10001 source.cjs privacy.cjs /app/scripts/help-learning/\n')
(r/'.dev-runtime/help-learning-source-image-proof.json').write_text(json.dumps({'baseImage':base,'baseId':c['Image'],'files':{n:hashlib.sha256((out/n).read_bytes()).hexdigest() for n in ['source.cjs','privacy.cjs','source-schema.sql']}},indent=2))
print('Read-only source image context prepared')
