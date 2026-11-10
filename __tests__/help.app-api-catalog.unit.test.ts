import {appApiCatalogueMetadata,getAppApiOperation,searchAppApiOperations} from '../src/modules/help/help.app-api-catalog';

test('inventory exposes actual application methods and nested/loop-generated Help routes',()=>{
  expect(appApiCatalogueMetadata.operationCount).toBeGreaterThan(300);
  expect(appApiCatalogueMetadata.unresolvedRegistrations).toEqual([]);
  for(const id of ['GET /help/tickets','GET /help/tickets/{id}','POST /help/tickets/{id}/assistant/retry','POST /help/tickets/{id}/close','GET /users/{userId}/profile','GET /stock-balances/products','PATCH /users/profile','DELETE /users/departments/{departmentId}']){
    expect(getAppApiOperation(id)).toMatchObject({id});
  }
  expect(getAppApiOperation('GET https://evil.invalid/')).toBeUndefined();
  expect(getAppApiOperation('GET /unregistered-endpoint')).toBeUndefined();
});
test('Russian chat/profile discovery returns exact method/path schemas with bounded pagination',()=>{
  const chats=searchAppApiOperations({query:'чат',method:'GET',limit:20});
  expect(chats.operations.some(row=>row.id==='GET /help/tickets')).toBe(true);
  expect(searchAppApiOperations({query:'профиль',method:'GET',limit:20}).operations.some(row=>row.id==='GET /users/{userId}/profile')).toBe(true);
  const first=searchAppApiOperations({limit:2}),next=searchAppApiOperations({limit:2,offset:2});
  expect(first.operations).toHaveLength(2);expect(next.operations).toHaveLength(2);
  expect(first.operations.map(row=>row.id).some(id=>next.operations.some(row=>row.id===id))).toBe(false);
  expect(first.hasMore).toBe(true);expect(first.total).toBe(appApiCatalogueMetadata.operationCount);
  expect(()=>searchAppApiOperations({limit:21})).toThrow();expect(()=>searchAppApiOperations({offset:-1})).toThrow();
});
test('a GET position-ingestion route is not presented as read-only JSON',()=>{
  expect(getAppApiOperation('GET /tracking/native/osmand')).toMatchObject({transport:'integration',effect:'write'});
  expect(getAppApiOperation('POST /auth/token')).toMatchObject({transport:'credential',effect:'write'});
  expect(getAppApiOperation('POST /users/me/profiles/{type}/avatar')).toMatchObject({transport:'multipart'});
  expect(getAppApiOperation('GET /help/attachments/{id}')).toMatchObject({transport:'binary'});
  expect(getAppApiOperation('GET /help/t3/requests/{id}')).toMatchObject({transport:'internal'});
  expect(getAppApiOperation('GET /help/tickets/{id}')).toMatchObject({transport:'json',effect:'read'});
  for(const id of ['POST /entity-links/resolve','POST /entity-links/preview','POST /help/tickets/summaries','POST /api/client-orders/products/batch','POST /api/client-orders/submissions/status','POST /api/client-orders/invoice-statuses'])expect(getAppApiOperation(id)).toMatchObject({effect:'read'});
  for(const id of ['POST /tracking/device/bootstrap','POST /users/me/email/change/start','GET /users/me/phone/verification/{sessionId}'])expect(getAppApiOperation(id)).toMatchObject({transport:'credential'});
  expect(getAppApiOperation('POST /ota/update')).toMatchObject({transport:'binary',effect:'read'});
  for(const id of ['POST /api/marketplace/orders','POST /api/client-orders/submissions/batch','POST /api/client-orders/{guid}/submit','PATCH /api/client-orders/{guid}'])expect(getAppApiOperation(id)).toMatchObject({transport:'integration',effect:'write'});
});
test('path/query and body hints retain API arguments without embedding response bodies or source paths',()=>{
  const read=getAppApiOperation('GET /help/tickets/{id}')!;
  expect(read.parameters).toContainEqual({name:'id',in:'path',required:true,schema:{type:'string'}});
  expect(getAppApiOperation('GET /help/tickets')!.parameters.map(parameter=>parameter.name)).toEqual(expect.arrayContaining(['status','scope','q','cursor']));
  const create=getAppApiOperation('POST /help/tickets')!;
  expect(create.schemaSource).toBe('route-validator-hints');
  expect((create.requestBody as any).content['application/json'].schema.properties).toHaveProperty('clientTicketId');
  expect((create.requestBody as any).content['application/json'].schema.required).toEqual(expect.arrayContaining(['clientTicketId','clientMessageId']));
  expect(JSON.stringify(create)).not.toMatch(/sourceFile|\/home\/|DATABASE_URL|ACCESS_TOKEN_SECRET/);
});

test('Help IT handoff keeps its existing explicit UI confirmation path',()=>{
 expect(getAppApiOperation('POST /help/tickets/{id}/request-it')?.transport).toBe('internal');expect(getAppApiOperation('POST /help/tickets/{id}/claim')?.transport).toBe('internal');
});
