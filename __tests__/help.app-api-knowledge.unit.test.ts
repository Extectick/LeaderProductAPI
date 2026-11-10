jest.mock('../src/prisma/client',()=>({__esModule:true,default:{$transaction:jest.fn()}}));
jest.mock('../src/modules/knowledge/knowledge.service',()=>({knowledgeActor:jest.fn()}));
jest.mock('../src/modules/knowledge/knowledge.config',()=>({
  KnowledgeError:class extends Error{constructor(public status:number,public code:string,message=code){super(message)}},
  SOURCE_FRESH_MS:600000,knowledgeConfig:jest.fn(),
}));
import prisma from '../src/prisma/client';
import {knowledgeActor} from '../src/modules/knowledge/knowledge.service';
import {knowledgeConfig,KnowledgeError} from '../src/modules/knowledge/knowledge.config';
import {helpAppApiKnowledgeFence} from '../src/modules/help/help.app-api-knowledge';
const sourceId='11111111-1111-4111-8111-111111111111',documentId='22222222-2222-4222-8222-222222222222',versionId='33333333-3333-4333-8333-333333333333';
let source:any,document:any,version:any,actor:any,db:any,events:string[];
beforeEach(()=>{
  jest.clearAllMocks();events=[];
  source={id:sourceId,key:'company',configFingerprint:'fingerprint',enabled:true,lastErrorCode:null,lastSuccessAt:new Date(Date.now()-1000)};
  document={id:documentId,sourceId,remoteId:'remote',path:'Материалы компании/guide.md',title:'Guide',section:'COMPANY',etag:'etag',size:10n,mimeType:'text/markdown',currentRevision:1,publishedRevision:1,publishedAt:new Date('2026-01-01T00:00:00Z'),allEmployees:false,allowedUserIds:[7],allowedDepartmentIds:[],deletedAt:null,updatedAt:new Date('2026-01-01T00:00:00Z')};
  version={id:versionId,documentId,revision:1,etag:'etag',path:document.path,status:'READY',sha256:'a'.repeat(64),errorCode:null,extractor:'text-v1',extractedAt:new Date('2026-01-01T00:00:00Z')};
  actor={userId:7,canManage:false,departmentIds:[4]};
  db={$queryRaw:jest.fn(async(strings:TemplateStringsArray)=>{events.push(strings.join(' '));return [];}),knowledgeSource:{findMany:jest.fn(async()=>[source])},knowledgeDocument:{findMany:jest.fn(async()=>[document])},knowledgeVersion:{findMany:jest.fn(async()=>[version])}};
  jest.mocked(prisma.$transaction).mockImplementation(async(fn:any)=>fn(db));
  jest.mocked(knowledgeActor).mockImplementation(async()=>actor);
  jest.mocked(knowledgeConfig).mockReturnValue({key:'company',fingerprint:'fingerprint'} as any);
});
const published=()=>({documentId,title:document.title,path:document.path,versionId,revision:1,text:'Private permitted excerpt'});
test('read is inside source lock and final supplied transaction rechecks ACL/version without reading text',async()=>{
  const fence=helpAppApiKnowledgeFence(7),raw=published();
  expect(await fence.capture(`/knowledge/documents/${documentId}/published`,async()=>{expect(events[0]).toMatch(/KnowledgeSource.*FOR SHARE/);events.push('API read');return raw;})).toBe(raw);
  expect(events.findIndex(event=>event.includes('KnowledgeDocument'))).toBeGreaterThan(events.indexOf('API read'));
  expect(events.some(event=>event.includes('KnowledgeVersion')&&event.includes('FOR SHARE'))).toBe(true);
  const transactions=jest.mocked(prisma.$transaction).mock.calls.length;
  await fence.validate(db);expect(jest.mocked(prisma.$transaction).mock.calls).toHaveLength(transactions);
  expect(db.knowledgeVersion.findMany.mock.calls.every(([args]:any)=>!args.select.text)).toBe(true);
  expect(db.knowledgeDocument.findMany.mock.calls.every(([args]:any)=>!args.select.text&&!args.select.versions)).toBe(true);
});
test('admin can read an unpublished/stale draft and historical version through normal API semantics',async()=>{
  actor={...actor,canManage:true};source.enabled=false;source.lastSuccessAt=new Date(0);document.section='AI_WORKSPACE';document.publishedRevision=null;version.status='ERROR';
  const fence=helpAppApiKnowledgeFence(7),raw={document:{id:documentId,currentRevision:1,publishedRevision:null},version:{...version,text:'Admin draft'}};
  expect(await fence.capture(`/knowledge/documents/${documentId}/versions/1`,async()=>raw)).toBe(raw);
  await expect(fence.validate(db)).resolves.toBeUndefined();
  actor={...actor,canManage:false};await expect(fence.validate(db)).rejects.toMatchObject({code:'HELP_KNOWLEDGE_CHANGED'});
});
test.each(['allEmployees','allowedUserIds','publishedRevision','currentRevision','deletedAt','etag'])('changed document %s invalidates a captured answer',async field=>{
  const fence=helpAppApiKnowledgeFence(7);await fence.capture('/knowledge/search?q=test',async()=>({results:[{documentId,versionId,revision:1,excerpt:'Excerpt'}]}));
  document={...document,[field]:field==='allowedUserIds'?[]:field==='deletedAt'?new Date():field==='allEmployees'?true:field.includes('Revision')?2:'changed'};
  await expect(fence.validate(db)).rejects.toMatchObject({status:409,code:'HELP_KNOWLEDGE_CHANGED'});
});
test.each(['configFingerprint','enabled','lastErrorCode','lastSuccessAt'])('source %s change/revocation/freshness invalidates a captured answer',async field=>{
  const fence=helpAppApiKnowledgeFence(7);await fence.capture(`/knowledge/documents/${documentId}/published`,async()=>published());
  source={...source,[field]:field==='enabled'?false:field==='lastSuccessAt'?new Date(0):'changed'};
  await expect(fence.validate(db)).rejects.toMatchObject({code:'HELP_KNOWLEDGE_CHANGED'});
});
test.each(['status','sha256','revision','etag'])('version %s cannot change between API read and publication',async field=>{
  const fence=helpAppApiKnowledgeFence(7);await fence.capture(`/knowledge/documents/${documentId}/published`,async()=>published());
  version={...version,[field]:field==='revision'?2:'changed'};
  await expect(fence.validate(db)).rejects.toMatchObject({code:'HELP_KNOWLEDGE_CHANGED'});
});
test('a version changing during read is rejected before content reaches the model',async()=>{
  actor={...actor,canManage:true};const fence=helpAppApiKnowledgeFence(7);
  await expect(fence.capture(`/knowledge/documents/${documentId}/versions/1`,async()=>{const old={...version,text:'Before change'};version={...version,status:'PROCESSING'};return {version:old};})).rejects.toMatchObject({code:'HELP_KNOWLEDGE_CHANGED'});
});
test('real API permission errors and unrelated API reads preserve their original result',async()=>{
  const denied={code:'KNOWLEDGE_FORBIDDEN',message:'Denied'},fence=helpAppApiKnowledgeFence(7);
  expect(await fence.capture(`/knowledge/documents/${documentId}/published`,async()=>denied)).toBe(denied);
  expect(knowledgeActor).not.toHaveBeenCalled();await fence.validate(db);expect(knowledgeActor).not.toHaveBeenCalled();
  jest.clearAllMocks();const raw={profile:{id:7}};expect(await fence.capture('/users/profile',async()=>raw)).toBe(raw);expect(prisma.$transaction).not.toHaveBeenCalled();
});
test('configuration failure preserves the real API error instead of inventing a read receipt',async()=>{
  jest.mocked(knowledgeConfig).mockImplementation(()=>{throw new KnowledgeError(503,'KNOWLEDGE_DISABLED')});
  const fence=helpAppApiKnowledgeFence(7),raw={code:'KNOWLEDGE_DISABLED'};
  expect(await fence.capture('/knowledge/config',async()=>raw)).toBe(raw);await fence.validate(db);expect(prisma.$transaction).not.toHaveBeenCalled();
});
test('a failed capture transaction does not retain receipts for unpublished data',async()=>{
  const fence=helpAppApiKnowledgeFence(7);
  jest.mocked(prisma.$transaction).mockImplementationOnce(async(fn:any)=>{await fn(db);throw new Error('COMMIT_FAILED')});
  await expect(fence.capture(`/knowledge/documents/${documentId}/published`,async()=>published())).rejects.toThrow('COMMIT_FAILED');
  jest.clearAllMocks();await fence.validate(db);expect(knowledgeActor).not.toHaveBeenCalled();
});
