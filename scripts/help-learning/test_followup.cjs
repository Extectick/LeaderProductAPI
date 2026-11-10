'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createStore}=require('./store.cjs');
const {validatePlan,readFollowupPlan,buildFollowupReport,readIssuesReadOnly,run}=require('./followup.cjs');
const hash=value=>createHash('sha256').update(value).digest('hex');
const NOW=Date.parse('2026-11-06T12:00:00Z');
const issue=(extra={})=>({id:hash('issue'),ticketId:1,code:'REPEATED_INSTRUCTION',status:'NEW',sourceState:'CURRENT',updatedAt:NOW,...extra});
const proof=(kind,outcome,at=NOW+10,ref=kind==='test'?'help/repeated-instruction':kind)=>({kind,outcome,observedAt:at,ref,sha256:hash([kind,outcome,at,ref].join(':'))});
const plan=(entry={})=>({state:'VALID',operator:'workspace-owner',entries:[{issueId:hash('issue'),category:'AI_BEHAVIOR',testCases:['help/repeated-instruction'],evidence:[],...entry}]});
const action=(value=issue(),entry={},now=NOW+100)=>buildFollowupReport([value],plan(entry),{now}).issues[0].nextAction;
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'help-followup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('follow-up output is deterministic and contains only references, never dialogue or model descriptions',()=>{
 const input=[issue({description:'Raw private dialogue is not report data'})],p=plan();
 const a=buildFollowupReport(input,p,{now:NOW}),b=buildFollowupReport(input,p,{now:NOW});assert.deepEqual(a,b);
 assert.equal(a.issues[0].status,'NEW');assert.equal(a.issues[0].category,'AI_BEHAVIOR');assert.equal(a.issues[0].classificationSource,'OPERATOR');assert.equal(a.issues[0].requiresOperator,true);
 assert.ok(!JSON.stringify(a).includes('Raw private'));assert.equal(input[0].status,'NEW');assert.equal(a.issues[0].nextAction,'REPRODUCE_CURRENT_RUNTIME');
});
test('unassigned observations keep UNKNOWN; code-based suggestions never become trusted classifications',()=>{
 const report=buildFollowupReport([issue({code:'INAPPROPRIATE_IT_COMMUNICATION'})],undefined,{now:NOW});
 assert.equal(report.issues[0].suggestedCategory,'HUMAN_COMMUNICATION');assert.equal(report.issues[0].category,'UNKNOWN');assert.equal(report.issues[0].nextAction,'CLASSIFY_ORIGIN');assert.equal(report.issues[0].classificationSource,'UNASSIGNED');
});
test('operator-assigned human communications go to service review, not AI code changes',()=>{
 assert.equal(action(issue(),{category:'HUMAN_COMMUNICATION',evidence:[proof('test','FAIL')]}),'HUMAN_SERVICE_REVIEW');
});
test('stale or revoked source is not an automatic dismissal or a verified repair',()=>{
 for(const state of ['STALE','REVOKED']){const row=buildFollowupReport([issue({sourceState:state})],plan({evidence:[proof('test','PASS'),proof('deployment','PASS')]}),{now:NOW+100}).issues[0];assert.equal(row.status,'NEW');assert.equal(row.nextAction,'REVALIDATE_SOURCE');}
});
test('only a bound failing test or trusted inspection can suggest confirming a new issue',()=>{
 assert.equal(action(issue(),{evidence:[proof('test','FAIL')]}),'CONFIRM_WITH_OPERATOR');
 assert.equal(action(issue(),{evidence:[proof('inspection','CONFIRMED')]}),'CONFIRM_WITH_OPERATOR');
 assert.equal(action(issue(),{evidence:[proof('test','FAIL',NOW+10,'other-case')]}),'REPRODUCE_CURRENT_RUNTIME');
 assert.equal(action(issue(),{evidence:[proof('test','FAIL',NOW+1000)]}),'REPRODUCE_CURRENT_RUNTIME');
});
test('confirmed issues need registered regressions, successful checks and deployment evidence',()=>{
 const row=issue({status:'CONFIRMED'});
 assert.equal(action(row,{testCases:[]}),'ADD_REGRESSION_CASE');
 assert.equal(action(row,{evidence:[proof('test','PASS')]}),'IMPLEMENT_AND_CHECK');
 assert.equal(action(row,{evidence:[proof('deployment','PASS',NOW+20),proof('test','PASS',NOW+30)]}),'REQUEST_FIXED_TRANSITION');
 assert.equal(action(row,{evidence:[proof('deployment','PASS',NOW+30),proof('test','PASS',NOW+20)]}),'IMPLEMENT_AND_CHECK');
});
test('verification requires a fresh check after FIXED and deployment; a closed regression needs new failure evidence',()=>{
 const evidence=[proof('deployment','PASS',NOW+10),proof('test','PASS',NOW+20)];
 assert.equal(action(issue({status:'FIXED',updatedAt:NOW+25}),{evidence}),'CHECK_DEPLOYED_FIX');
 assert.equal(action(issue({status:'FIXED',updatedAt:NOW+15}),{evidence}),'REQUEST_VERIFIED_TRANSITION');
 for(const status of ['VERIFIED','DISMISSED']){
  assert.equal(action(issue({status}),{evidence:[proof('test','FAIL',NOW-1)]}),'CLOSED');
  assert.equal(action(issue({status}),{evidence:[proof('test','FAIL',NOW+20)]}),'REOPEN_WITH_OPERATOR');
  assert.equal(action(issue({status,sourceState:'REVOKED'}),{evidence:[proof('test','FAIL',NOW+20)]}),'REVALIDATE_SOURCE');
 }
});
test('plans reject model operators, transcript fields, duplicate IDs, paths, unknown categories and sensitive refs',()=>{
 const value={schemaVersion:1,audience:'IT_REVIEW_ONLY',operator:'workspace-owner',entries:[{issueId:hash('issue'),category:'UNKNOWN',testCases:[]}]};
 assert.deepEqual(validatePlan(value),value);
 for(const change of [{operator:'model'},{audience:'ALL_EMPLOYEES'},{entries:[value.entries[0],value.entries[0]]},{entries:[{...value.entries[0],category:'SELF_VERIFIED'}]},{entries:[{...value.entries[0],dialogue:'private'}]},{entries:[{...value.entries[0],evidenceManifest:'../secret'}]},{entries:[{...value.entries[0],testCases:['password:abcdef']}]}])assert.throws(()=>validatePlan({...value,...change}),/INVALID_FOLLOWUP/);
});
test('optional plan corruption, symlink, excess permissions or artifact mismatch is quarantined without losing analysis',t=>{
 const directory=temp(t),file=path.join(directory,'followup-plan.json');assert.equal(readFollowupPlan(directory).state,'ABSENT');
 fs.writeFileSync(file,'{',{mode:0o600});assert.equal(readFollowupPlan(directory).state,'INVALID');
 fs.writeFileSync(file,JSON.stringify({schemaVersion:1,audience:'IT_REVIEW_ONLY',operator:'workspace-owner',entries:[]}));fs.chmodSync(file,0o644);assert.equal(readFollowupPlan(directory).state,'INVALID');
 fs.chmodSync(file,0o600);assert.equal(readFollowupPlan(directory).state,'VALID');fs.unlinkSync(file);fs.symlinkSync(path.join(directory,'absent'),file);
 assert.equal(readFollowupPlan(directory).state,'INVALID');
 fs.unlinkSync(file);fs.writeFileSync(file,JSON.stringify({schemaVersion:1,audience:'IT_REVIEW_ONLY',operator:'workspace-owner',entries:[{issueId:hash('issue'),category:'AI_BEHAVIOR',testCases:['help/repeated-instruction'],evidenceManifest:'evidence.json'}]}),{mode:0o600});
 fs.writeFileSync(path.join(directory,'case.log'),'actual test output',{mode:0o600});fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify({schemaVersion:1,evidence:[{...proof('test','PASS'),artifact:'case.log',sha256:hash('wrong')}]}),{mode:0o600});assert.equal(readFollowupPlan(directory).state,'INVALID');
 const report=buildFollowupReport([issue()],readFollowupPlan(directory),{now:NOW});assert.equal(report.planError,'HELP_LEARNING_INVALID_FOLLOWUP');assert.equal(report.issues[0].category,'UNKNOWN');
});
test('a valid plan verifies artifact bytes and retains only their audited hash and reference',t=>{
 const directory=temp(t),bytes='synthetic fixture passed',file=path.join(directory,'case.log');fs.writeFileSync(file,bytes,{mode:0o600});
 fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify({schemaVersion:1,evidence:[{...proof('test','FAIL'),sha256:hash(bytes),artifact:'case.log'}]}),{mode:0o600});
 fs.writeFileSync(path.join(directory,'followup-plan.json'),JSON.stringify({schemaVersion:1,audience:'IT_REVIEW_ONLY',operator:'workspace-owner',entries:[{issueId:hash('issue'),category:'AI_BEHAVIOR',testCases:['help/repeated-instruction'],evidenceManifest:'evidence.json'}]}),{mode:0o600});
 const p=readFollowupPlan(directory);assert.equal(p.state,'VALID');assert.equal(action(issue(),p.entries[0]),'CONFIRM_WITH_OPERATOR');assert.ok(!JSON.stringify(p).includes(bytes));
});
test('read-only reporting preserves every SQLite row, cursor, issue decision and transition',t=>{
 const directory=temp(t),store=createStore(directory),source={ticketId:1,sourceVersion:'a'.repeat(64),status:'OPEN',closedAt:null,itRequested:false,updatedAt:'2026-11-06T00:00:00Z',lastEventId:1,truncated:false,messages:[{id:1,sequence:1,authorRole:'OWNER',kind:'TEXT',text:'Synthetic check',rating:null,createdAt:'2026-11-06T00:00:00Z'}],jobs:[],privacyFlags:[]};
 const batch=store.claimBatch({schemaVersion:1,afterEventId:0,nextEventId:1,hasMore:false,snapshots:[source]},{now:NOW});store.completeBatch(batch.batchId,batch.leaseToken,[{ticketId:1,sourceVersion:'a'.repeat(64),decision:'needs_review',summary:'Synthetic check',issues:[{code:'REPEATED_INSTRUCTION',evidenceMessageIds:[1],description:'Synthetic check'}],resolution:{confirmed:false,evidenceMessageIds:[]},instruction:null,regressionTests:[]}],[source],{now:NOW+1});
 const before=store.status(),decisions=store.listIssues(),transitions=store.listTransitions();const rows=readIssuesReadOnly(directory);assert.equal(rows.length,1);
 const result=run(['report','--state-dir',directory]);assert.equal(result.ok,true);assert.deepEqual(store.status(),before);assert.deepEqual(store.listIssues(),decisions);assert.deepEqual(store.listTransitions(),transitions);
 assert.equal(fs.statSync(path.join(directory,'issue-queue','followup.json')).mode&0o777,0o600);assert.ok(!JSON.stringify(result).includes(decisions[0].id));
 assert.throws(()=>run(['report','--state-dir',directory,'--output',path.join(directory,'help-learning.sqlite')]),/INVALID_ARGUMENTS/);
 const db=new DatabaseSync(path.join(directory,'help-learning.sqlite'),{readOnly:true});assert.equal(db.prepare("SELECT value FROM meta WHERE key='cursor'").get().value,'1');db.close();store.close();
});
