jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  helpMessage: { findMany: jest.fn() }, knowledgeSource: { findFirst: jest.fn() },
} }));
jest.mock('../src/modules/knowledge/knowledge.config', () => ({
  ...jest.requireActual('../src/modules/knowledge/knowledge.config'), knowledgeEnabled: () => true,
}));
jest.mock('../src/modules/knowledge/knowledge.service', () => ({ knowledgeActor: jest.fn(), knowledgeSourceWhere: jest.fn() }));
import prisma from '../src/prisma/client';
import { knowledgeActor } from '../src/modules/knowledge/knowledge.service';
import { retrieveHelpKnowledge } from '../src/modules/help/help.knowledge';
test('ticket 28 request bypasses retrieval even when storage is unavailable, after actor authorization', async () => {
  (knowledgeActor as jest.Mock).mockResolvedValue({ userId: 7 });
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{ authorId: 7, text: 'Мне нужен it специалист подключи', sequence: 5 }]);
  const result = await retrieveHelpKnowledge(28, 7, []);
  expect(knowledgeActor).toHaveBeenCalledWith(7);
  expect(result).toMatchObject({ answer: { handoffReason: 'user_requested' } });
  expect(result).toMatchObject({ answer: { action: { type: 'request_it' } } });
  expect('answer' in result && result.answer.text).toContain('подтвердите передачу');
  expect('answer' in result && result.answer.text).not.toMatch(/Подключаю|Передаю/);
  expect('answer' in result && result.answer.text).toContain('Переписка');
  expect(prisma.knowledgeSource.findFirst).not.toHaveBeenCalled();
});
