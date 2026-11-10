jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  helpAssistantJob: { findUnique: jest.fn() }, helpAttachment: { findMany: jest.fn() },
} }));
jest.mock('../src/modules/help/help.service', () => ({ HelpError: class extends Error {}, helpActor: jest.fn(), helpTransaction: jest.fn(), publishHelpEvent: jest.fn() }));
jest.mock('../src/modules/help/help.openai-answer', () => ({ prepareHelpOpenAIAnswer: jest.fn() }));
jest.mock('../src/modules/help/help.assistant-lease', () => ({ withHelpAssistantLease: jest.fn((_id, _token, work) => work(new AbortController().signal)) }));
jest.mock('../src/modules/help/help.ai-files', () => ({ prepareHelpAIFiles: jest.fn(), prepareHelpOfficeFiles: jest.fn(), prepareHelpHtmlFiles: jest.fn(), cleanupHelpAIFiles: jest.fn() }));
import prisma from '../src/prisma/client';
import { processHelpAssistantJob } from '../src/modules/help/help.assistant';
import { helpTransaction, publishHelpEvent } from '../src/modules/help/help.service';
import { prepareHelpOpenAIAnswer } from '../src/modules/help/help.openai-answer';
import { prepareHelpAIFiles, prepareHelpOfficeFiles, prepareHelpHtmlFiles, cleanupHelpAIFiles } from '../src/modules/help/help.ai-files';
import * as knowledge from '../src/modules/help/help.knowledge';
import * as onec from '../src/modules/onec-personal/service';
const original = { ...process.env };
const initial = { id: 'run', provider: 'openai', ticketId: 32, ownerId: 7, leaseToken: 'lease', leaseUntil: new Date(Date.now() + 90000), status: 'RUNNING', step: 3, messageId: 250, context: [], createdAt: new Date(), attempts: 1 };
const prepared = [{ id: 'file-id', objectKey: 'help/ai/32/run/attempt.txt', name: 'test.txt', kind: 'FILE' as const, mimeType: 'text/plain', size: 10, sha256: 'hash', position: 0 }];
let db: any, current: any, ticket: any;
beforeEach(() => {
  jest.clearAllMocks(); process.env = { ...original, HELP_AI_PROVIDER: 'openai', HELP_OPENAI_MAX_ATTEMPTS: '2' };
  current = { ...initial }; ticket = { id: 32, ownerId: 7, status: 'OPEN', itRequested: false, members: [] };
  (prisma.helpAssistantJob.findUnique as jest.Mock).mockResolvedValue(initial);
  (prisma.helpAttachment.findMany as jest.Mock).mockResolvedValue([]);
  (prepareHelpOpenAIAnswer as jest.Mock).mockResolvedValue({ mode: 'openai', text: 'Тестовый TXT.', sources: [], files: [{ name: 'test.txt', content: 'private generated text' }] });
  (prepareHelpAIFiles as jest.Mock).mockResolvedValue(prepared);
  db = { $executeRaw: jest.fn(), helpAssistantJob: { findUnique: jest.fn(async () => current), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: jest.fn(async () => current) },
    helpTicket: { findUniqueOrThrow: jest.fn(async () => ticket), update: jest.fn() },
    helpAttachment: { createMany: jest.fn() },
    helpMessage: { findUnique: jest.fn().mockResolvedValue({ assistantState: { activityVersion: 1, activities: [] } }), update: jest.fn() } };
  (helpTransaction as jest.Mock).mockImplementation((_id, fn) => fn(db));
  (publishHelpEvent as jest.Mock).mockResolvedValue({ id: 100 });
});
afterEach(() => { process.env = original; jest.restoreAllMocks(); });
test('publishes a real owner-scoped attachment with the final text/event and no raw file content in assistantState', async () => {
  await expect(processHelpAssistantJob('run', 'lease')).resolves.toBe(true);
  expect(prepareHelpAIFiles).toHaveBeenCalledWith({ ticketId: 32, runId: 'run' }, [{ name: 'test.txt', content: 'private generated text' }], expect.any(AbortSignal));
  expect(db.helpAttachment.createMany).toHaveBeenCalledWith({ data: [{ ...prepared[0], ownerId: 7, messageId: 250 }] });
  expect(db.helpMessage.update).toHaveBeenCalledWith({ where: { id: 250 }, data: { text: 'Тестовый TXT.\n\nПрикреплены файлы: test.txt.', kind: 'TEXT' } });
  expect(publishHelpEvent).toHaveBeenCalledWith(db, 32, null, 'MESSAGE_CREATED', 250);
  expect(JSON.stringify(db.helpMessage.update.mock.calls)).not.toContain('private generated text');
  expect(cleanupHelpAIFiles).not.toHaveBeenCalled();
});
test.each(['cancel', 'changed-lease', 'IT', 'closed', 'provider', 'changed-owner'])('late generated files never publish after %s', async reason => {
  (prepareHelpAIFiles as jest.Mock).mockImplementation(async () => {
    if (reason === 'cancel') current = { ...current, status: 'STOPPED', leaseToken: null };
    if (reason === 'changed-lease') current = { ...current, leaseToken: 'new-lease' };
    if (reason === 'IT') ticket.itRequested = true;
    if (reason === 'closed') ticket.status = 'CLOSED';
    if (reason === 'provider') process.env.HELP_AI_PROVIDER = 'knowledge';
    if (reason === 'changed-owner') ticket.ownerId = 9;
    return prepared;
  });
  // cancelHelpAssistant sees no live jobs once IT takes the ticket.
  db.helpAssistantJob.findMany = jest.fn(async () => []);
  await expect(processHelpAssistantJob('run', 'lease')).resolves.toBe(false);
  expect(db.helpAttachment.createMany).not.toHaveBeenCalled();
  expect(db.helpMessage.update.mock.calls.some(([value]: any) => value.data.kind === 'TEXT')).toBe(false);
  expect(cleanupHelpAIFiles).toHaveBeenCalledWith(prepared);
});
test.each(['knowledge', 'onec'])('revoked %s rights remove private staged files before any final publication', async right => {
  const failure = Object.assign(new Error('denied'), { status: 403 });
  const answer: any = { mode: 'openai', text: 'Тестовый TXT.', sources: [], files: [{ name: 'test.txt', content: 'private generated text' }] };
  if (right === 'knowledge') jest.spyOn(knowledge, 'validateHelpKnowledgeSources').mockRejectedValueOnce(failure);
  else { answer.onecProofs = [{ baseKey: 'base', fingerprint: 'fixture' }]; jest.spyOn(onec, 'validateOnecProofs').mockRejectedValueOnce(failure); }
  (prepareHelpOpenAIAnswer as jest.Mock).mockResolvedValue(answer);
  await expect(processHelpAssistantJob('run', 'lease')).resolves.toBe(false);
  expect(db.helpAttachment.createMany).not.toHaveBeenCalled();
  expect(cleanupHelpAIFiles).toHaveBeenCalledWith(prepared);
});
test('a losing COMPLETED claim cannot append duplicate attachments', async () => {
  db.helpAssistantJob.updateMany.mockResolvedValue({ count: 0 });
  await expect(processHelpAssistantJob('run', 'lease')).resolves.toBe(false);
  expect(db.helpAttachment.createMany).not.toHaveBeenCalled();
  expect(cleanupHelpAIFiles).toHaveBeenCalledWith(prepared);
});
test('lost COMMIT acknowledgement preserves objects already referenced by committed attachment rows', async () => {
  let transactions = 0;
  (helpTransaction as jest.Mock).mockImplementation(async (_id, fn) => {
    const value = await fn(db);
    if (++transactions === 1) { current = { ...current, status: 'COMPLETED', leaseToken: null }; throw new Error('commit acknowledgement lost'); }
    return value;
  });
  (prisma.helpAttachment.findMany as jest.Mock).mockResolvedValue([{ id: 'file-id' }]);
  await expect(processHelpAssistantJob('run', 'lease')).resolves.toBe(false);
  expect(cleanupHelpAIFiles).toHaveBeenCalledWith([]);
  expect(db.helpAttachment.createMany).toHaveBeenCalledTimes(1);
});
test('an unavailable reference check preserves private objects instead of deleting a possibly committed file', async () => {
  db.helpAssistantJob.updateMany.mockResolvedValue({ count: 0 });
  (prisma.helpAttachment.findMany as jest.Mock).mockRejectedValue(new Error('db unavailable'));
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(processHelpAssistantJob('run', 'lease')).resolves.toBe(false);
  expect(cleanupHelpAIFiles).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('[help-ai-files] cleanup deferred', { code: 'HELP_AI_FILE_PUBLICATION_UNKNOWN' });
});

test('Office attachments use the same final lease transaction as text exports',async()=>{
 (prepareHelpOpenAIAnswer as jest.Mock).mockResolvedValue({mode:'openai',text:'Excel готов.',sources:[],officeFiles:[{name:'report.xlsx',mimeType:'fixture',kind:'FILE',bytes:Buffer.from('private-office-bytes')}]});
 const office=[{...prepared[0],name:'report.xlsx',objectKey:'help/ai/32/run/report.xlsx'}];
 (prepareHelpOfficeFiles as jest.Mock).mockResolvedValue(office);
 await expect(processHelpAssistantJob('run','lease')).resolves.toBe(true);
 expect(prepareHelpOfficeFiles).toHaveBeenCalledWith({ticketId:32,runId:'run'},expect.any(Array),expect.any(AbortSignal),0);
 expect(db.helpAttachment.createMany).toHaveBeenCalledWith({data:[{...office[0],ownerId:7,messageId:250}]});
 expect(JSON.stringify(db.helpMessage.update.mock.calls)).not.toContain('private-office-bytes');
});

// HTML uses the identical lease-fenced attachment transaction, without JSON filenames in the reply.
test('publishes HTML as ordinary answer content without exposing its transport filename', async()=>{
 const descriptor={...prepared[0],name:'72be2240-3200-43ae-b7f9-cf837bca2c78.help-html.json',mimeType:'application/vnd.leaderproduct.help-html+json'};
 const htmlFile={name:descriptor.name,mimeType:descriptor.mimeType,kind:'FILE',bytes:Buffer.from('private html descriptor'),reviewText:'Example'};
 (prepareHelpOpenAIAnswer as jest.Mock).mockResolvedValue({mode:'openai',text:'Наглядный пример.',sources:[],files:[],htmlFiles:[htmlFile]});
 (prepareHelpHtmlFiles as jest.Mock).mockResolvedValue([descriptor]);
 await expect(processHelpAssistantJob('run','lease')).resolves.toBe(true);
 expect(prepareHelpHtmlFiles).toHaveBeenCalledWith({ticketId:32,runId:'run'},[htmlFile],expect.any(AbortSignal),0);
 expect(db.helpAttachment.createMany).toHaveBeenCalledWith({data:[{...descriptor,ownerId:7,messageId:250}]});
 expect(db.helpMessage.update).toHaveBeenCalledWith({where:{id:250},data:{text:'Наглядный пример.',kind:'TEXT'}});
});
test('HTML staged after cancellation is cleaned without publication',async()=>{
 const descriptor={...prepared[0],mimeType:'application/vnd.leaderproduct.help-html+json'};
 (prepareHelpOpenAIAnswer as jest.Mock).mockResolvedValue({mode:'openai',text:'Пример',sources:[],htmlFiles:[{}]});
 (prepareHelpHtmlFiles as jest.Mock).mockImplementation(async()=>{current.status='STOPPED';return [descriptor];});
 await expect(processHelpAssistantJob('run','lease')).resolves.toBe(false);
 expect(db.helpAttachment.createMany).not.toHaveBeenCalled();expect(cleanupHelpAIFiles).toHaveBeenCalledWith([descriptor]);
});
