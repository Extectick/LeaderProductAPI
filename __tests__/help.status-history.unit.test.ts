const mockDb = {
  helpTicket: { findUnique: jest.fn() },
  helpMessage: { findMany: jest.fn(), findFirst: jest.fn() },
  helpEvent: { findMany: jest.fn(), findFirst: jest.fn() },
  user: { findMany: jest.fn() },
};
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { $transaction: (work: (db: typeof mockDb) => unknown) => work(mockDb) } }));
jest.mock('../src/services/serviceAccess', () => ({ explainServiceAccessForUser: jest.fn() }));
import { helpMessages } from '../src/modules/help/help.service';

describe('Help status events in paginated history', () => {
  const actor = { userId: 7, canManage: false };
  const message = (id: number, kind = 'TEXT', rating: number | null = null) => ({ id, ticketId: 11, sequence: id, authorId: 7, authorRole: 'USER', kind, rating, text: `Сообщение ${id}`, attachments: [], reactions: [] });
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.helpTicket.findUnique.mockResolvedValue({ id: 11, status: 'OPEN', messageSequence: 3, members: [{ userId: 7, role: 'OWNER', lastReadSequence: 3 }] });
    mockDb.helpMessage.findFirst.mockResolvedValue(null);
    mockDb.helpEvent.findFirst.mockResolvedValue(null);
    mockDb.user.findMany.mockResolvedValue([{ id: 7, firstName: 'Алексей', lastName: '', avatarUrl: null, employeeProfile: null }]);
    mockDb.helpEvent.findMany.mockResolvedValue([]);
  });
  test('a reopened ticket retains its earlier closure, rating and reopen event in history', async () => {
    mockDb.helpMessage.findMany.mockResolvedValue([message(3), message(2), message(1, 'CLOSURE', 4)]);
    mockDb.helpEvent.findMany.mockResolvedValue([{ messageId: 1, type: 'TICKET_CLOSED' }, { messageId: 2, type: 'TICKET_REOPENED' }]);
    const page = await helpMessages(11, actor);
    expect(page.messages.map(row => [row.id, row.ticketStatusChange, row.rating])).toEqual([[1, 'CLOSED', 4], [2, 'REOPENED', null], [3, null, null]]);
    expect(mockDb.helpEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ticketId: { in: [11] }, messageId: { in: [1, 2, 3] } }) }));
  });
  test('legacy closure still carries its status when its journal event is absent', async () => {
    mockDb.helpMessage.findMany.mockResolvedValue([message(1, 'CLOSURE', 0)]);
    expect((await helpMessages(11, actor)).messages[0]).toMatchObject({ kind: 'CLOSURE', ticketStatusChange: 'CLOSED', rating: 0 });
  });
  test('status journal cannot be read for an inaccessible ticket', async () => {
    mockDb.helpTicket.findUnique.mockResolvedValue({ id: 11, members: [{ userId: 8, role: 'OWNER' }] });
    await expect(helpMessages(11, actor)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.helpEvent.findMany).not.toHaveBeenCalled();
  });
});
