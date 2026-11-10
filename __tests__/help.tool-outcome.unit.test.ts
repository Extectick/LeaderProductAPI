import {describeHelpToolOutcome,withHelpToolOutcome,planHelpAppReadback,verifyHelpAppReadback,type HelpToolOutcomeContext} from '../src/modules/help/help.tool-outcome';
import {getAppApiOperation} from '../src/modules/help/help.app-api-catalog';

const query:HelpToolOutcomeContext={source:'personal_onec',effect:'read',scope:'warehouse.stock.filtered',freshness:'live',observedAt:'2026-11-06T12:00:00Z'};
const ok=(data:unknown)=>({success:true,status:200,data});
test('a complete scoped zero-row read is empty, while an unknown or partial zero-row read is not',()=>{
 const data={baseKey:'qa',data:JSON.stringify({success:true,data:[],rowCount:0})};
 expect(describeHelpToolOutcome(data,{...query,complete:true})).toMatchObject({status:'empty',completeness:'complete',observedRecords:0,scope:'warehouse.stock.filtered'});
 expect(describeHelpToolOutcome(data,query)).toMatchObject({status:'success',completeness:'unknown',observedRecords:0});
 expect(describeHelpToolOutcome({...data,data:JSON.stringify({success:true,data:[],truncated:true})},{...query,complete:true})).toMatchObject({status:'partial',completeness:'partial',observedRecords:0,flags:['truncated']});
});
test.each([
 [{error:'ONEC_AUTH_REQUIRED'},'forbidden','authentication_required'],
 [{error:'APP_API_FORBIDDEN',status:403},'forbidden','access_denied'],
 [{error:'APP_API_NOT_FOUND',status:404},'unavailable','not_found'],
 [{error:'APP_API_UNAVAILABLE'},'unavailable','unavailable'],
 [{success:false,data:[]},'unavailable','unavailable'],
 [{ok:false,error:{code:'VALIDATION_ERROR'}},'unavailable','invalid_arguments'],
] as const)('failure stays distinct from empty data: %j',(payload,status,kind)=>{
 const result=describeHelpToolOutcome(payload,{...query,complete:true,recordCount:0});expect(result.status).toBe(status);expect(result.error?.kind).toBe(kind);expect(result.status).not.toBe('empty');
});
test('nested HTTP-success business denial stays forbidden and retains its diagnostic code',()=>{
 expect(describeHelpToolOutcome(ok({ok:false,error:{code:'SERVICE_ACCESS_DENIED'}}),{source:'application_api',effect:'read'})).toMatchObject({status:'forbidden',error:{code:'SERVICE_ACCESS_DENIED',httpStatus:200,kind:'access_denied'}});
});
test('ordinary business records named error/status/code do not become adapter failures',()=>{
 const payload=ok({error:'Business field value',status:403,code:'FORBIDDEN',description:'valid record'});
 expect(describeHelpToolOutcome(payload,{source:'application_api',effect:'read'})).toMatchObject({status:'success',error:null});
});
test('domain completion flags are not transport truncation or completeness proofs',()=>{
 expect(describeHelpToolOutcome(ok({id:7,complete:false,status:'OPEN',partial:true}),{source:'application_api',effect:'read'})).toMatchObject({status:'success',completeness:'unknown',flags:[]});
 expect(describeHelpToolOutcome(ok({id:7,complete:true}),{source:'application_api',effect:'read'})).toMatchObject({status:'success',completeness:'unknown'});
});
test('pagination, contradictory row counts and blocked shared-account reads never prove complete absence',()=>{
 const context={source:'application_api',effect:'read',complete:true} as const;
 expect(describeHelpToolOutcome(ok({ok:true,data:[],hasMore:true}),context)).toMatchObject({status:'partial',flags:['more_available']});
 expect(describeHelpToolOutcome(ok([{id:1}]),{...context,recordCount:0})).toMatchObject({status:'partial',observedRecords:1,flags:['count_mismatch']});
 expect(describeHelpToolOutcome({...ok([]),liveOnecReadBlocked:true},{...context,freshness:'live'})).toMatchObject({status:'partial',provenance:{freshness:'unknown'},flags:['fresh_read_blocked']});
});
test('a terminal event-replay checkpoint is not a next-page cursor',()=>{
 expect(describeHelpToolOutcome({success:true,data:[],hasMore:false,nextCursor:1654},{source:'history',effect:'read',scope:'ticket.sync.since_event',complete:true})).toMatchObject({status:'empty',completeness:'complete',flags:[]});
 expect(describeHelpToolOutcome({success:true,data:[],nextCursor:0},{source:'history',effect:'read'})).toMatchObject({status:'success',completeness:'unknown',flags:[]});
});
test('Office preparation and gateway inventory do not become completed business writes or fresh network checks',()=>{
 expect(describeHelpToolOutcome({created:true,size:10,partial:true},{source:'office_artifact',effect:'artifact'})).toMatchObject({status:'partial',mutation:null,provenance:{freshness:'unknown',observedAt:null}});
 expect(describeHelpToolOutcome({success:true,live:false,inventoryDate:'2026-11-06'},{source:'gateway',effect:'read',freshness:'inventory'})).toMatchObject({status:'success',provenance:{freshness:'inventory',observedAt:null}});
});
test('normalization preserves the exact sanitized typed payload and bounds metadata rather than copying arbitrary arguments/errors',()=>{
 const data={data:[{amount:0,price:-1,id:'abc'}],truncated:false},payload=ok(data);
 const result=withHelpToolOutcome(payload,{source:'application_api',effect:'read',scope:'https://private.example/secret',observedAt:'not-a-date',operationId:'https://evil.example/'+ 'x'.repeat(5000)});
 expect(result.data).toBe(payload.data);expect(payload).not.toHaveProperty('outcome');expect(result.outcome.scope).toBeNull();expect(result.outcome.provenance.operationId).toBeNull();expect(result.outcome.provenance.observedAt).toBeNull();
 const invalid=describeHelpToolOutcome({error:'password=secret-token-'+ 'x'.repeat(5000)},{source:'application_api',effect:'read'});expect(invalid.error?.code).toBeNull();expect(JSON.stringify(invalid)).not.toContain('secret-token');expect(JSON.stringify(invalid).length).toBeLessThan(1500);
});
test('unknown mutation outcomes remain unknown and replayed successes mean accepted, not verified state',()=>{
 expect(describeHelpToolOutcome({error:'APP_API_WRITE_OUTCOME_UNKNOWN'},{source:'application_api',effect:'write'})).toMatchObject({status:'unknown',mutation:{state:'unknown',replayed:false},error:{kind:'unknown_outcome'}});
 expect(describeHelpToolOutcome({success:true,status:200,replayed:true},{source:'application_api',effect:'write'})).toMatchObject({status:'success',mutation:{state:'accepted',replayed:true},completeness:'unknown'});
});

const close={operationId:'POST /help/tickets/{id}/close',path:{id:7}};
const receipt=ok({ticket:{id:7,status:'CLOSED'}});
const options=(data:unknown)=>({requesterId:1,signal:new AbortController().signal,validateAccess:jest.fn(async()=>{}),read:jest.fn(async()=>data)});
test('close readback uses one exact catalogue GET and verifies only the current expected state',async()=>{
 const plan=planHelpAppReadback(close,receipt,1)!;expect(plan.request).toEqual({operationId:'GET /help/tickets/{id}',path:{id:7}});
 const run=options(receipt);await expect(verifyHelpAppReadback(plan,run)).resolves.toMatchObject({writeState:'accepted',status:'verified',target:{kind:'ticket',id:7},checkedFields:['status'],writeRepeated:false});
 expect(run.read).toHaveBeenCalledTimes(1);expect(run.validateAccess).toHaveBeenCalledTimes(2);
});
test('create reads only the returned ticket identity; receipts without identity cannot invent a target',()=>{
 const plan=planHelpAppReadback({operationId:'POST /help/tickets'},ok({ticket:{id:81,status:'OPEN'}}),1)!;expect(plan.target).toEqual({kind:'ticket',id:81});
 expect(planHelpAppReadback({operationId:'POST /help/tickets'},{success:true,status:200,replayed:true},1)).toBeNull();
 expect(planHelpAppReadback({operationId:'POST /help/tickets'},ok({id:81}),1)).toBeNull();
});
test('profile changes bind to the authenticated requester and route normalization, not body identity hints',async()=>{
 const plan=planHelpAppReadback({operationId:'PATCH /users/profile',body:{firstName:'  Иван  ',middleName:''}},ok({ok:true,data:{profile:{id:1,firstName:'Иван',middleName:null}}}),1)!;
 expect(plan.request.path).toEqual({userId:1});expect(plan.expected).toEqual({firstName:'Иван',middleName:null});
 const run=options(ok({ok:true,data:{profile:{id:1,firstName:'Иван',middleName:null}}}));expect((await verifyHelpAppReadback(plan,run)).status).toBe('verified');
 const unknown=planHelpAppReadback({operationId:'PATCH /users/profile',body:{userId:99,phone:null}},ok({ok:true}),1)!;expect(unknown.expected).toEqual({});expect(unknown.target.id).toBe(1);
});
test('resource read alone cannot verify an unsupported mutation field or message delivery',async()=>{
 const plan=planHelpAppReadback({operationId:'POST /help/tickets/{id}/messages',path:{id:7}},receipt,1)!;
 expect((await verifyHelpAppReadback(plan,options(receipt))).status).toBe('resource_read');
});
test('readback cannot turn an uncertain write into a confirmed execution or repeat it',async()=>{
 const plan=planHelpAppReadback(close,{error:'APP_API_WRITE_OUTCOME_UNKNOWN'},1)!;
 expect(await verifyHelpAppReadback(plan,options(receipt))).toMatchObject({writeState:'unknown',status:'state_matches',writeRepeated:false});
 const run=options(receipt);run.read.mockRejectedValue(new Error('network lost'));
 expect(await verifyHelpAppReadback(plan,run)).toMatchObject({writeState:'unknown',status:'unavailable',writeRepeated:false});expect(run.read).toHaveBeenCalledTimes(1);
});
test('a committed write remains accepted when current readback fails, is partial, loses access or mismatches identity/state',async()=>{
 const plan=planHelpAppReadback(close,receipt,1)!;
 for(const [value,status]of [[{error:'APP_API_UNAVAILABLE'},'unavailable'],[{error:'APP_API_FORBIDDEN',status:403},'forbidden'],[{error:'APP_API_NOT_FOUND',status:404},'unavailable'],[{...receipt,truncated:true},'unavailable'],[ok({ticket:{id:8,status:'CLOSED'}}),'mismatch'],[ok({ticket:{id:7,status:'OPEN'}}),'mismatch']] as const){
  const result=await verifyHelpAppReadback(plan,options(value));expect(result.writeState).toBe('accepted');expect(result.status).toBe(status);expect(result.writeRepeated).toBe(false);
 }
});
test('fresh requester ACL changes reject before and after reading, without exposing a result',async()=>{
 const plan=planHelpAppReadback(close,receipt,1)!;
 const before=options(receipt);before.validateAccess.mockRejectedValue(new Error('REVOKED'));await expect(verifyHelpAppReadback(plan,before)).rejects.toThrow('REVOKED');expect(before.read).not.toHaveBeenCalled();
 const after=options(receipt);after.validateAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('REVOKED'));await expect(verifyHelpAppReadback(plan,after)).rejects.toThrow('REVOKED');expect(after.read).toHaveBeenCalledTimes(1);
});
test('plans cannot be forged, serialized and replayed under a different identity, or changed into arbitrary operations',async()=>{
 const plan=planHelpAppReadback(close,receipt,1)!;await expect(verifyHelpAppReadback(JSON.parse(JSON.stringify(plan)),options(receipt))).rejects.toThrow('PLAN_INVALID');
 await expect(verifyHelpAppReadback(plan,{...options(receipt),requesterId:2})).rejects.toThrow('IDENTITY_CHANGED');
 expect(Object.isFrozen(plan)).toBe(true);expect(Object.isFrozen(plan.request.path)).toBe(true);
 const aborted=options(receipt);aborted.signal=AbortSignal.abort();await expect(verifyHelpAppReadback(plan,aborted)).rejects.toThrow();expect(aborted.read).not.toHaveBeenCalled();
});
test('catalogue effects, transport and exact route identity are checked; a POST read is never treated as a mutation',()=>{
 expect(planHelpAppReadback({operationId:'POST /help/tickets/summaries'},ok({}),1)).toBeNull();
 expect(planHelpAppReadback({operationId:'POST /help/tickets/{id}/request-it',path:{id:7}},ok({}),1)).toBeNull();
 expect(planHelpAppReadback({operationId:'DELETE /users/departments/{departmentId}',path:{departmentId:7}},ok({}),1)).toBeNull();
 expect(planHelpAppReadback({...close,path:{id:'../7'}},receipt,1)).toBeNull();
 const catalogue=(id:string)=>{const op=getAppApiOperation(id);return op&&id.startsWith('GET /help/tickets')?{...op,path:'https://evil.example'}:op;};
 expect(planHelpAppReadback(close,receipt,1,catalogue)).toBeNull();
});
