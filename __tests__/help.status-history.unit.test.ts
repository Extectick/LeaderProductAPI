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
  test('handoff markers survive history with one event lookup and a real surname-first join avatar',async()=>{
    mockDb.helpMessage.findMany.mockResolvedValue([
      {...message(3,'SYSTEM'),text:'Продолжаем с AI'},
      {...message(2,'SYSTEM'),authorId:8,text:'Иванов Иван подключился'},
      {...message(1,'SYSTEM'),text:'Вызван IT-специалист'},
    ]);
    mockDb.user.findMany.mockResolvedValue([{id:7,firstName:'Автор',lastName:'',avatarUrl:null},{id:8,firstName:'Иван',lastName:'Иванов',avatarUrl:'/avatar-old',employeeProfile:{avatarUrl:'/avatar-current'}}]);
    mockDb.helpEvent.findMany.mockResolvedValue([{messageId:1,type:'IT_REQUESTED'},{messageId:2,type:'IT_JOINED'},{messageId:3,type:'AI_RESUMED'}]);
    const page=await helpMessages(11,actor);
    expect(page.messages.map(row=>row.itStatusChange)).toEqual(['REQUESTED','JOINED','AI_RESUMED']);
    expect(page.messages.every(row=>row.ticketStatusChange===null)).toBe(true);
    expect(page.messages[1].author).toEqual({id:8,name:'Иванов Иван',avatarUrl:'/avatar-current'});
    expect(mockDb.helpEvent.findMany).toHaveBeenCalledTimes(1);expect(mockDb.user.findMany).toHaveBeenCalledTimes(1);
  });

  test('leave metadata preserves the recorded surname-first name even after profile changes',async()=>{
    mockDb.helpMessage.findMany.mockResolvedValue([{...message(4,'SYSTEM'),authorId:8,text:'Иванов Иван отключился'}]);
    mockDb.user.findMany.mockResolvedValue([{id:8,firstName:'Новое имя',lastName:'Новая фамилия',avatarUrl:'/avatar'}]);
    mockDb.helpEvent.findMany.mockResolvedValue([{messageId:4,type:'IT_LEFT'}]);
    expect((await helpMessages(11,actor)).messages[0]).toMatchObject({itStatusChange:'LEFT',text:'Иванов Иван отключился',author:{id:8,name:'Иванов Иван',avatarUrl:'/avatar'}});
  });

});
