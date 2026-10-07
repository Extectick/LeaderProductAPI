const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const cfg=JSON.parse(fs.readFileSync('C:/ProgramData/LeaderProduct/GlitchTipProd/credentials.json'));
const dsn=new URL(cfg.dsn);assert.equal(dsn.hostname,'api.leader-product.ru');assert.equal(cfg.environment,'production');
const url=id=>`${cfg.sentryUrl}/api/0/projects/${cfg.organization}/${cfg.project}/events/${id}/`;
async function main(){
 if(process.argv[2]==='read'){
  const id=process.argv[3];assert.match(id,/^[a-f0-9]{32}$/);
  const r=await fetch(url(id),{headers:{Authorization:`Bearer ${cfg.readToken}`},signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200);const e=await r.json();const exceptions=e.entries?.find(x=>x.type==='exception')?.data?.values||[];
  console.log(JSON.stringify({eventId:id,stored:true,environment:e.contexts?.environment||e.tags?.find(t=>t.key==='environment')?.value,exception:exceptions[0]?.type}));return;
 }
 const id=crypto.randomBytes(16).toString('hex');
 const e={event_id:id,timestamp:Date.now()/1000,platform:'javascript',environment:'production',level:'error',release:'prod-monitoring-ingestion-smoke',tags:{qa_smoke:'ingestion-only-not-user-crash'},exception:{values:[{type:'ProductionDiagnosticsSmoke',value:'Synthetic production ingestion check; not a user crash'}]}};
 const r=await fetch(`https://api.leader-product.ru/sentry/api/${cfg.projectId}/envelope/`,{method:'POST',headers:{'Content-Type':'application/x-sentry-envelope','X-Sentry-Auth':`Sentry sentry_version=7,sentry_key=${dsn.username}`},body:[JSON.stringify({event_id:id,dsn:cfg.dsn}),JSON.stringify({type:'event'}),JSON.stringify(e),''].join('\n'),signal:AbortSignal.timeout(20000)});
 assert.equal(r.status,200);
 const hidden=await fetch('https://api.leader-product.ru/sentry/api/0/projects/',{signal:AbortSignal.timeout(15000)});
 assert.equal(hidden.status,404);
 const anon=await fetch(url(id),{signal:AbortSignal.timeout(15000)});assert.ok([401,403].includes(anon.status));
 console.log(JSON.stringify({eventId:id,accepted:r.status,publicAdmin:hidden.status,anonymousRead:anon.status}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
