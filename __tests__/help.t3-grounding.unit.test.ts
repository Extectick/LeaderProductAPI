jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  helpMessage: { findMany: jest.fn() }, $transaction: jest.fn(),
} }));
jest.mock('../src/modules/knowledge/knowledge.config', () => ({ knowledgeEnabled: () => true }));
jest.mock('../src/modules/help/help.knowledge', () => ({
  retrieveHelpKnowledge: jest.fn(), renderKnowledgeExcerpts: jest.fn(),
  validateHelpKnowledgeSources: jest.fn(), knowledgeHandoff: jest.fn(),
}));
jest.mock('../src/modules/help/help.t3-exchange', () => ({ requestT3Answer: jest.fn() }));

import prisma from '../src/prisma/client';
import { retrieveHelpKnowledge } from '../src/modules/help/help.knowledge';
import { requestT3Answer } from '../src/modules/help/help.t3-exchange';
import { prepareHelpT3Answer } from '../src/modules/help/help.t3';

const original = { ...process.env };
const job = { id: 'qa-job', ticketId: 3, ownerId: 7, leaseToken: 'lease' };
const signal = new AbortController().signal;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...original };
  delete process.env.HELP_T3_ALLOW_GENERAL;
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{ authorId: 7, text: 'Не печатает принтер' }]);
  (requestT3Answer as jest.Mock).mockResolvedValue({ decision: 'clarify', message: 'Какая модель принтера?', source_ids: [], responseId: 'qa-response' });
});
afterAll(() => { process.env = original; });

test('keeps the existing no-knowledge handoff unless general support is explicitly enabled', async () => {
  const answer = { text: 'Передаю в IT', handoffReason: 'no_knowledge', sources: [] };
  (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({ answer });
  await expect(prepareHelpT3Answer(job, [], signal)).resolves.toBe(answer);
  expect(requestT3Answer).not.toHaveBeenCalled();
});

test('explicit general mode sends only ticket history with no invented company sources', async () => {
  process.env.HELP_T3_ALLOW_GENERAL = 'true';
  (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({ answer: { handoffReason: 'no_knowledge' } });
  await expect(prepareHelpT3Answer(job, [], signal)).resolves.toMatchObject({
    mode: 't3', text: 'Какая модель принтера?', sources: [], generation: { model: 't3-configured-provider' },
  });
  expect(requestT3Answer).toHaveBeenCalledWith(job, {
    messages: [{ role: 'user', text: 'Не печатает принтер' }], sources: [],
  }, [], signal);
  expect(prisma.helpMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ticketId: 3 }) }));
});

test.each(['source_unavailable', 'user_requested'])('general mode preserves %s without calling the model', async handoffReason => {
  process.env.HELP_T3_ALLOW_GENERAL = 'true';
  const answer = { handoffReason, text: 'Передаю в IT', sources: [] };
  (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({ answer });
  await expect(prepareHelpT3Answer(job, [], signal)).resolves.toBe(answer);
  expect(requestT3Answer).not.toHaveBeenCalled();
  expect(prisma.helpMessage.findMany).not.toHaveBeenCalled();
});
