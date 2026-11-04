jest.mock('../src/prisma/client', () => ({__esModule: true, default: {helpAssistantJob: {findUnique: jest.fn()}}}));
jest.mock('../src/modules/help/help.service', () => ({HelpError: class extends Error {constructor(public status: number, public code: string, message: string) {super(message);}}, helpActor: jest.fn(), helpTransaction: jest.fn(), publishHelpEvent: jest.fn()}));
jest.mock('../src/modules/help/help.bunny', () => ({bunnyConfiguration: () => ({enabled: true, maxAttempts: 3}), HelpBunnyError: class extends Error {}, prepareHelpBunnyAnswer: jest.fn()}));
jest.mock('../src/modules/help/help.assistant-lease', () => ({withHelpAssistantLease: jest.fn((_id, _token, work) => work(new AbortController().signal))}));
import prisma from '../src/prisma/client';
import {processHelpAssistantJob} from '../src/modules/help/help.assistant';
import {helpTransaction, publishHelpEvent} from '../src/modules/help/help.service';
import {prepareHelpBunnyAnswer} from '../src/modules/help/help.bunny';
import {withHelpAssistantLease} from '../src/modules/help/help.assistant-lease';
const job = {id: 'job', provider: 'bunny', ticketId: 3, ownerId: 7, leaseToken: 'lease', leaseUntil: new Date(Date.now() + 90000), status: 'RUNNING', step: 3, messageId: 25, context: [{text: 'QA'}], createdAt: new Date(), attempts: 1};
let db: any;
beforeEach(() => {
  jest.clearAllMocks();
  (prisma.helpAssistantJob.findUnique as jest.Mock).mockResolvedValue(job);
  db = {helpAssistantJob: {findUnique: jest.fn().mockResolvedValue(job), updateMany: jest.fn().mockResolvedValue({count: 1}), findUniqueOrThrow: jest.fn().mockResolvedValue({...job, step: 4})},
    helpTicket: {findUniqueOrThrow: jest.fn().mockResolvedValue({id: 3, status: 'OPEN', itRequested: false, members: []}), update: jest.fn()}, helpMessage: {update: jest.fn()}};
  (helpTransaction as jest.Mock).mockImplementation((_id, work) => work(db));
  (publishHelpEvent as jest.Mock).mockResolvedValue({id: 100});
  (prepareHelpBunnyAnswer as jest.Mock).mockResolvedValue({mode: 'bunny', text: 'Какая ошибка?', sources: [], generation: {model: 'bunny-qwen3.5-4b'}});
});
test('Bunny replaces the progress placeholder through the fenced durable completion path', async () => {
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(true);
  expect(withHelpAssistantLease).toHaveBeenCalledWith('job', 'lease', expect.any(Function), undefined);
  expect(prepareHelpBunnyAnswer).toHaveBeenCalledWith(3, 7, job.context, expect.any(AbortSignal));
  expect(db.helpMessage.update).toHaveBeenCalledWith({where: {id: 25}, data: {text: 'Какая ошибка?', kind: 'TEXT'}});
  expect(publishHelpEvent).toHaveBeenCalledWith(db, 3, null, 'MESSAGE_CREATED', 25);
});
test('a superseded job never commits a late model response', async () => {
  db.helpAssistantJob.findUnique.mockResolvedValue({...job, status: 'SUPERSEDED', leaseToken: null});
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
  expect(db.helpMessage.update).not.toHaveBeenCalled(); expect(publishHelpEvent).not.toHaveBeenCalled();
});
test('IT handoff prevents a late model response from replacing the chat', async () => {
  db.helpTicket.findUniqueOrThrow.mockResolvedValue({id: 3, status: 'OPEN', itRequested: true, members: []});
  db.helpAssistantJob.findMany = jest.fn().mockResolvedValue([]);
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
  expect(db.helpMessage.update).not.toHaveBeenCalled();
});

test('switching to Bunny cannot finish older simulator jobs with a stub', async () => {
  const originalProvider = process.env.HELP_AI_PROVIDER; process.env.HELP_AI_PROVIDER = 'bunny';
  (prisma.helpAssistantJob.findUnique as jest.Mock).mockResolvedValue({...job, provider: 'simulator'});
  try {
    await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
    expect(prepareHelpBunnyAnswer).not.toHaveBeenCalled();
    expect(db.helpAssistantJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({status: 'ERROR', errorCode: 'HELP_AI_PROVIDER_UNAVAILABLE'})}));
    expect(db.helpMessage.update).not.toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({kind: 'TEXT'})}));
  } finally { if (originalProvider === undefined) delete process.env.HELP_AI_PROVIDER; else process.env.HELP_AI_PROVIDER = originalProvider; }
});
