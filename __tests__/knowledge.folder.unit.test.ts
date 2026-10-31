jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {} }));
import { publishFolderVersion } from '../src/modules/knowledge/knowledge.folder';
import { knowledgeConfig } from '../src/modules/knowledge/knowledge.config';
const original = { ...process.env };
beforeEach(() => { Object.assign(process.env, { KNOWLEDGE_ENABLED:'true', KNOWLEDGE_PUBLICATION_MODE:'folder', KNOWLEDGE_SOURCE_KEY:'test-folder', KNOWLEDGE_NEXTCLOUD_URL:'https://example.org', KNOWLEDGE_NEXTCLOUD_USER:'reader', KNOWLEDGE_NEXTCLOUD_PASSWORD:'fixture' }); });
afterEach(() => { process.env = { ...original }; });
function setup() {
  const doc = { id:'doc',sourceId:'source',section:'COMPANY',deletedAt:null,currentRevision:2,publishedRevision:null,allEmployees:false,allowedUserIds:[] as number[],allowedDepartmentIds:[] as number[],source:{enabled:true,lastSuccessAt:new Date(),lastErrorCode:null,configFingerprint:knowledgeConfig().fingerprint} };
  const version = { id:'version',revision:2,status:'READY' };
  const tx:any = { knowledgeAuditEvent:{ findFirst:jest.fn().mockResolvedValue(null),create:jest.fn() },knowledgeDocument:{update:jest.fn()} };
  return {doc,version,tx};
}
test('folder publication opts in explicitly and never includes drafts, archive, stale or superseded content', async () => {
  const {doc,version,tx}=setup();
  process.env.KNOWLEDGE_PUBLICATION_MODE='manual'; expect(await publishFolderVersion(tx,doc,version)).toBe(false);
  process.env.KNOWLEDGE_PUBLICATION_MODE='folder';
  for(const section of ['AI_WORKSPACE','ARCHIVE','OTHER']) expect(await publishFolderVersion(tx,{...doc,section},version)).toBe(false);
  expect(await publishFolderVersion(tx,doc,{...version,revision:1})).toBe(false);
  expect(await publishFolderVersion(tx,{...doc,source:{...doc.source,lastSuccessAt:new Date(0)}},version)).toBe(false);
  expect(tx.knowledgeDocument.update).not.toHaveBeenCalled();
});
test('a new company document is published once for employees', async () => {
  const {doc,version,tx}=setup();
  expect(await publishFolderVersion(tx,doc,version)).toBe(true);
  expect(tx.knowledgeDocument.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({allEmployees:true,publishedRevision:2})}));
  expect(await publishFolderVersion(tx,{...doc,publishedRevision:2},version)).toBe(false);
  expect(tx.knowledgeDocument.update).toHaveBeenCalledTimes(1);
});
test('manual revocation wins, including a timestamp tie', async () => {
  const {doc,version,tx}=setup(); const at=new Date();
  tx.knowledgeAuditEvent.findFirst.mockResolvedValue({createdAt:at});
  expect(await publishFolderVersion(tx,doc,version)).toBe(false);
  expect(tx.knowledgeDocument.update).not.toHaveBeenCalled();
});
test('republishing an edited file keeps its explicit restricted audience', async () => {
  const {doc,version,tx}=setup();
  tx.knowledgeAuditEvent.findFirst.mockImplementation(({where}:any)=>where.action==='PUBLISHED'?Promise.resolve({createdAt:new Date()}):Promise.resolve(null));
  expect(await publishFolderVersion(tx,{...doc,allowedUserIds:[7]},version)).toBe(true);
  expect(tx.knowledgeDocument.update.mock.calls[0][0].data).not.toHaveProperty('allEmployees');
  expect(tx.knowledgeDocument.update.mock.calls[0][0].data).not.toHaveProperty('allowedUserIds');
});
