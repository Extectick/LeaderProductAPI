jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { $transaction: jest.fn() } }));
jest.mock('../src/modules/help/help.assistant', () => ({ cancelHelpAssistant: jest.fn(), enqueueHelpAssistant: jest.fn(), helpAssistantConfiguration: jest.fn() }));
import prisma from '../src/prisma/client';
import { helpItAction } from '../src/modules/help/help.service';
import { cancelHelpAssistant } from '../src/modules/help/help.assistant';
let db: any, ticket: any;
beforeEach(() => {
  jest.clearAllMocks();
  ticket = { id: 24, ownerId:7, messageSequence:1, status: 'OPEN', itRequested: false, members: [{ userId: 7, role: 'OWNER' }] };
  db = { $executeRaw: jest.fn(), helpTicket: { findUnique: jest.fn(async () => ticket), update: jest.fn(async ({ data }) => Object.assign(ticket, {...data,...(data.messageSequence?{messageSequence:ticket.messageSequence+data.messageSequence.increment}:{})})) },
    helpMessage:{create:jest.fn(async({data})=>({id:101,...data}))},
    helpEvent: { create: jest.fn(async ({ data }) => ({ id: 100, ...data })) }, helpMember: { findMany: jest.fn(async () => []) },
    helpNotification: { createMany: jest.fn() }, role: { findMany: jest.fn(async () => []) }, user: { findMany: jest.fn(async () => []) } };
  (prisma.$transaction as jest.Mock).mockImplementation(work => work(db));
});
test('the explicit confirmation endpoint queues IT, stops AI and emits its event only once', async () => {
  await helpItAction(24, { userId: 7, canManage: false }, false);
  expect(ticket.itRequested).toBe(true);
  expect(cancelHelpAssistant).toHaveBeenCalledWith(db, 24, 'handoff');
  expect(db.helpEvent.create).toHaveBeenCalledWith({ data: { ticketId: 24, actorId: 7, type: 'IT_REQUESTED', messageId: 101 } });
  await helpItAction(24, { userId: 7, canManage: false }, false);
  expect(db.helpEvent.create).toHaveBeenCalledTimes(1);
  expect(cancelHelpAssistant).toHaveBeenCalledTimes(1);
});
test('closed or inaccessible tickets cannot be transferred from a stale confirmation', async () => {
  ticket.status = 'CLOSED';
  await expect(helpItAction(24, { userId: 7, canManage: false }, false)).rejects.toMatchObject({ code: 'TICKET_CLOSED' });
  ticket.status = 'OPEN';
  await expect(helpItAction(24, { userId: 9, canManage: false }, false)).rejects.toMatchObject({ code: 'HELP_NOT_FOUND' });
  expect(db.helpEvent.create).not.toHaveBeenCalled();
  expect(ticket.itRequested).toBe(false);
});
