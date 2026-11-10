'use strict';
// Trusted follow-up metadata complements the existing issue/transition journal.
// It never executes a test, changes a status, publishes knowledge or calls a model.
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {isPlainObject,containsSensitiveText}=require('./privacy.cjs');
const {readEvidence}=require('./triage.cjs');
const CATEGORIES=['AI_BEHAVIOR','INTEGRATION','HUMAN_COMMUNICATION','SYSTEM_LIFECYCLE','UNKNOWN'];
const STATUSES=['NEW','CONFIRMED','FIXED','VERIFIED','DISMISSED'];
const ID=/^[a-f0-9]{64}$/;
const REF=/^(?!.*(?:\.\.|\/\/))[A-Za-z0-9][A-Za-z0-9._:#/-]{0,199}$/;
function fail(code){throw Object.assign(new Error(code),{code});}
function keys(value,required,optional=[]){if(!isPlainObject(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))fail('HELP_LEARNING_INVALID_FOLLOWUP');}
function suggestedCategory(code){
 if(['INAPPROPRIATE_IT_COMMUNICATION','UNPROFESSIONAL_IT_RESPONSE'].includes(code))return 'HUMAN_COMMUNICATION';
 if(['GENERATION_STOPPED','RESPONSE_MISSING_AFTER_VALIDATION_ERROR'].includes(code))return 'SYSTEM_LIFECYCLE';
 if(['FILE_RESULT_MISSING','SERVICE_ERROR_RECOVERY_LOOP','UNVERIFIED_ERROR_CLASSIFICATION'].includes(code))return 'INTEGRATION';
 return 'AI_BEHAVIOR';
}
function validatePlan(value){
 keys(value,['schemaVersion','audience','operator','entries']);
 if(value.schemaVersion!==1||value.audience!=='IT_REVIEW_ONLY'||typeof value.operator!=='string'||!/^[a-z][a-z0-9_-]{2,63}$/.test(value.operator)||['model','assistant','system','scheduler','codex','t3'].includes(value.operator)||!Array.isArray(value.entries)||value.entries.length>1000)fail('HELP_LEARNING_INVALID_FOLLOWUP');
 const ids=new Set();
 const entries=value.entries.map(entry=>{
  keys(entry,['issueId','category','testCases'],['evidenceManifest']);
  if(!ID.test(entry.issueId)||ids.has(entry.issueId)||!CATEGORIES.includes(entry.category)||!Array.isArray(entry.testCases)||entry.testCases.length>16||new Set(entry.testCases).size!==entry.testCases.length||entry.testCases.some(id=>typeof id!=='string'||!REF.test(id)||containsSensitiveText(id)))fail('HELP_LEARNING_INVALID_FOLLOWUP');
  ids.add(entry.issueId);
  if(entry.evidenceManifest!==undefined&&(typeof entry.evidenceManifest!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.evidenceManifest)||entry.evidenceManifest.includes('..')))fail('HELP_LEARNING_INVALID_FOLLOWUP');
  return {...entry,testCases:[...entry.testCases].sort()};
 });
 return {...value,entries};
}
function validateEvidence(evidence){
 if(!Array.isArray(evidence)||evidence.length>16)fail('HELP_LEARNING_INVALID_FOLLOWUP');
 const ids=new Set();
 return evidence.map(proof=>{
  keys(proof,['kind','ref','sha256','outcome','observedAt']);
  if(!['inspection','test','deployment'].includes(proof.kind)||!['PASS','FAIL','CONFIRMED'].includes(proof.outcome)||typeof proof.ref!=='string'||!REF.test(proof.ref)||containsSensitiveText(proof.ref)||!ID.test(proof.sha256)||!Number.isSafeInteger(proof.observedAt)||proof.observedAt<0)fail('HELP_LEARNING_INVALID_FOLLOWUP');
  const id=[proof.kind,proof.ref,proof.sha256].join(':');if(ids.has(id))fail('HELP_LEARNING_INVALID_FOLLOWUP');ids.add(id);return {...proof};
 });
}
function boundedJson(filename,limit=262144){
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>limit||stat.mode&0o077)fail('HELP_LEARNING_INVALID_FOLLOWUP');
  const data=Buffer.alloc(limit+1);let offset=0;
  while(offset<=limit){const count=fs.readSync(fd,data,offset,limit+1-offset,null);if(!count)break;offset+=count;}
  if(offset>limit)fail('HELP_LEARNING_INVALID_FOLLOWUP');
  return JSON.parse(data.subarray(0,offset).toString('utf8'));
 }finally{fs.closeSync(fd);}
}
function readFollowupPlan(directory){
 const filename=path.join(directory,'followup-plan.json');
 try{if(fs.lstatSync(filename).isSymbolicLink())return {state:'INVALID',code:'HELP_LEARNING_INVALID_FOLLOWUP',entries:[]};}catch(error){return error.code==='ENOENT'?{state:'ABSENT',entries:[]}:{state:'INVALID',code:'HELP_LEARNING_INVALID_FOLLOWUP',entries:[]};}
 try{
  if(fs.lstatSync(directory).isSymbolicLink())fail('HELP_LEARNING_INVALID_FOLLOWUP');
  const plan=validatePlan(boundedJson(filename));
  return {state:'VALID',operator:plan.operator,entries:plan.entries.map(entry=>({...entry,evidence:validateEvidence(entry.evidenceManifest?readEvidence(path.join(directory,entry.evidenceManifest)):[])}))};
 }catch{return {state:'INVALID',code:'HELP_LEARNING_INVALID_FOLLOWUP',entries:[]};}
}
function nextAction(issue,entry,evidence,now){
 const tests=evidence.filter(proof=>proof.kind==='test'&&entry.testCases.includes(proof.ref)&&proof.observedAt<=now);
 const pass=tests.filter(proof=>proof.outcome==='PASS'),failures=tests.filter(proof=>proof.outcome==='FAIL');
 const deployment=evidence.filter(proof=>proof.kind==='deployment'&&proof.outcome==='PASS'&&proof.observedAt<=now);
 if(['VERIFIED','DISMISSED'].includes(issue.status))return failures.some(proof=>proof.observedAt>issue.updatedAt)?issue.sourceState==='CURRENT'?'REOPEN_WITH_OPERATOR':'REVALIDATE_SOURCE':'CLOSED';
 if(entry.category==='HUMAN_COMMUNICATION')return 'HUMAN_SERVICE_REVIEW';
 if(entry.category==='UNKNOWN')return 'CLASSIFY_ORIGIN';
 if(issue.sourceState!=='CURRENT')return 'REVALIDATE_SOURCE';
 if(issue.status==='NEW')return failures.length||evidence.some(proof=>proof.kind==='inspection'&&proof.outcome==='CONFIRMED'&&proof.observedAt<=now)?'CONFIRM_WITH_OPERATOR':'REPRODUCE_CURRENT_RUNTIME';
 if(!entry.testCases.length)return 'ADD_REGRESSION_CASE';
 if(issue.status==='CONFIRMED')return pass.length&&deployment.length&&pass.some(proof=>deployment.some(item=>proof.observedAt>=item.observedAt))?'REQUEST_FIXED_TRANSITION':'IMPLEMENT_AND_CHECK';
 if(issue.status==='FIXED')return pass.some(proof=>proof.observedAt>issue.updatedAt&&deployment.some(item=>proof.observedAt>=item.observedAt))?'REQUEST_VERIFIED_TRANSITION':'CHECK_DEPLOYED_FIX';
 return 'CLASSIFY_ORIGIN';
}
function buildFollowupReport(issues,plan={state:'ABSENT',entries:[]},options={}){
 const now=options.now??Date.now();
 if(!Number.isSafeInteger(now)||now<0||!Array.isArray(issues)||issues.length>1000)fail('HELP_LEARNING_INVALID_FOLLOWUP');
 if(!['ABSENT','INVALID','VALID'].includes(plan.state))fail('HELP_LEARNING_INVALID_FOLLOWUP');
 const trusted=plan.state==='VALID'?plan.entries:[];
 if(plan.state==='VALID')validatePlan({schemaVersion:1,audience:'IT_REVIEW_ONLY',operator:plan.operator,entries:trusted.map(({evidence,...entry})=>entry)});
 const entries=new Map(trusted.map(entry=>[entry.issueId,{...entry,evidence:validateEvidence(entry.evidence||[])}]));
 const rows=issues.map(issue=>{
  if(!ID.test(issue.id)||!STATUSES.includes(issue.status)||!Number.isSafeInteger(issue.ticketId)||issue.ticketId<1||!Number.isSafeInteger(issue.updatedAt)||issue.updatedAt<0||!['CURRENT','STALE','REVOKED'].includes(issue.sourceState)||typeof issue.code!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(issue.code))fail('HELP_LEARNING_INVALID_FOLLOWUP');
  const entry=entries.get(issue.id)||{category:'UNKNOWN',testCases:[],evidence:[]},evidence=entry.evidence||[];
  return {issueId:issue.id,ticketId:issue.ticketId,code:issue.code,status:issue.status,sourceState:issue.sourceState,
   category:entry.category,classificationSource:entries.has(issue.id)?'OPERATOR':'UNASSIGNED',suggestedCategory:suggestedCategory(issue.code),
   testCases:entry.testCases,evidence:evidence.map(({kind,ref,sha256,outcome,observedAt})=>({kind,ref,sha256,outcome,observedAt})),
   nextAction:nextAction(issue,entry,evidence,now),requiresOperator:true};
 }).sort((a,b)=>a.ticketId-b.ticketId||a.issueId.localeCompare(b.issueId));
 const tally=key=>Object.fromEntries([...new Set(rows.map(row=>row[key]))].sort().map(value=>[value,rows.filter(row=>row[key]===value).length]));
 return {schemaVersion:1,audience:'IT_REVIEW_ONLY',generatedAt:new Date(now).toISOString(),planState:plan.state,
  ...(plan.state==='INVALID'?{planError:'HELP_LEARNING_INVALID_FOLLOWUP'}:{}),
  summary:{issues:rows.length,statuses:tally('status'),categories:tally('category'),nextActions:tally('nextAction')},issues:rows};
}
function readIssuesReadOnly(stateDir){
 const directory=path.resolve(stateDir),file=path.join(directory,'help-learning.sqlite');
 if(fs.lstatSync(directory).isSymbolicLink()||fs.lstatSync(file).isSymbolicLink())fail('HELP_LEARNING_INVALID_STATE_FILE');
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  db.exec('BEGIN');
  return db.prepare('SELECT id,ticket_id,code,status,updated_at FROM issues ORDER BY ticket_id,id LIMIT 1001').all().map(row=>{
   const sources=db.prepare('SELECT source_state FROM issue_sources WHERE issue_id=?').all(row.id);
   return {id:row.id,ticketId:row.ticket_id,code:row.code,status:row.status,updatedAt:row.updated_at,
    sourceState:sources.some(s=>s.source_state==='CURRENT')?'CURRENT':sources.some(s=>s.source_state==='REVOKED')?'REVOKED':'STALE'};
  });
 }finally{try{db.exec('ROLLBACK');}finally{db.close();}}
}
function run(argv){
 const [command,flag,stateDir,...extra]=argv;if(command!=='report'||flag!=='--state-dir'||!stateDir||extra.length)fail('HELP_LEARNING_INVALID_ARGUMENTS');
 const directory=path.join(path.resolve(stateDir),'issue-queue');
 const report=buildFollowupReport(readIssuesReadOnly(stateDir),readFollowupPlan(directory));
 fs.mkdirSync(directory,{recursive:true,mode:0o700});if(fs.lstatSync(directory).isSymbolicLink())fail('HELP_LEARNING_INVALID_STATE_FILE');fs.chmodSync(directory,0o700);
 const target=path.join(directory,'followup.json');if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())fail('HELP_LEARNING_INVALID_STATE_FILE');
 const temporary=path.join(directory,`.followup-${require('node:crypto').randomUUID()}.tmp`);
 try{fs.writeFileSync(temporary,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,target);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
 return {ok:true,audience:report.audience,planState:report.planState,...report.summary};
}
if(require.main===module){try{console.log(JSON.stringify(run(process.argv.slice(2))));}catch(error){console.error(JSON.stringify({ok:false,code:/^HELP_LEARNING_[A-Z_]+$/.test(error.code||'')?error.code:'HELP_LEARNING_FOLLOWUP_FAILED'}));process.exitCode=1;}}
module.exports={CATEGORIES,validatePlan,readFollowupPlan,buildFollowupReport,readIssuesReadOnly,run};
