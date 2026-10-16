jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { $transaction: jest.fn(),
  clientOrderSubmission: { findMany: jest.fn() } } }));
import prisma from '../src/prisma/client';
import { acceptClientOrderSubmission, acceptClientOrderSubmissionBatch, getClientOrderSubmissionStatuses,
  submissionPayloadHash, SubmissionConflict } from '../src/modules/clientOrders/clientOrderSubmissions';

const payload = { organizationGuid: 'org', counterpartyGuid: 'customer', clientRevision: 1, intent: 'SUBMIT',
  items: [{ productGuid: 'product', lineGuid: 'line-guid-1234', quantity: 1, basePrice: 100 }],
  offlineReview: { pricePolicy: 'ASK' } };
const input = (body: any = payload) => ({ clientOrderId: 'client-id-123', payload: body, payloadHash: submissionPayloadHash(body) });
let tx: any;
beforeEach(() => {
  jest.clearAllMocks();
  tx = { order: { findFirst: jest.fn().mockResolvedValue({ id: 'owned' }) }, $queryRaw: jest.fn().mockResolvedValue([]), clientOrderSubmission: {
    findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(({ data }) => ({ ...data,
      id: 'receipt-123', acceptedAt: new Date('2026-10-16T10:00:00Z'), state: 'ACCEPTED' })),
  } };
  (prisma.$transaction as jest.Mock).mockImplementation(fn => fn(tx));
});
describe('durable async intake without 1C', () => {
  it('commits the entire immutable raw packet and returns an explicitly non-posting receipt', async () => {
    const result = await acceptClientOrderSubmission(90, input());
    expect(result).toMatchObject({ accepted: true, userId: 90, intent: 'SUBMIT', state: 'ACCEPTED',
      clientOrderId: input().clientOrderId, clientRevision: 1, payloadHash: input().payloadHash,
      receiptVersion: 'client-order-inbox-v1' });
    expect(tx.clientOrderSubmission.create.mock.calls[0][0].data.payload).toEqual(payload);
    expect(result).not.toHaveProperty('isPostedIn1c');
  });
  it('does not accept until its database commit succeeds', async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('commit failed'));
    await expect(acceptClientOrderSubmission(90, input())).rejects.toThrow('commit failed');
  });
  it('rejects a SAVE instead of silently escalating it', async () => {
    await expect(acceptClientOrderSubmission(90, input({ ...payload, intent: 'SAVE' }))).rejects.toThrow('Черновик');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejects a changed packet hash', async () => {
    await expect(acceptClientOrderSubmission(90, { ...input(), payloadHash: '0'.repeat(64) })).rejects.toThrow('изменился');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('matches hashes across property order and preserves Cyrillic and decimals', () => {
    expect(submissionPayloadHash({ a: 1.25, b: 'Куренкова 🐟' })).toBe(submissionPayloadHash({ b: 'Куренкова 🐟', a: 1.25 }));
  });
  it('replays the same receipt without insertion', async () => {
    const first = await acceptClientOrderSubmission(90, input());
    tx.clientOrderSubmission.findFirst.mockResolvedValue({ ...tx.clientOrderSubmission.create.mock.calls[0][0].data,
      id: first.submissionId, state: 'QUEUED', acceptedAt: new Date(first.acceptedAt) });
    expect((await acceptClientOrderSubmission(90, input())).submissionId).toBe(first.submissionId);
    expect(tx.clientOrderSubmission.create).toHaveBeenCalledTimes(1);
  });
  it('refuses another payload for the same revision', async () => {
    tx.clientOrderSubmission.findFirst.mockResolvedValue({ clientRevision: 1, payloadHash: 'other' });
    await expect(acceptClientOrderSubmission(90, input())).rejects.toBeInstanceOf(SubmissionConflict);
  });
  it('does not replace a newer accepted operation with an old revision', async () => {
    tx.clientOrderSubmission.findFirst.mockResolvedValue({ clientRevision: 2, state: 'QUEUED' });
    await expect(acceptClientOrderSubmission(90, input())).rejects.toMatchObject({ code: 'STALE_CLIENT_REVISION' });
  });
  it('does not allow a new revision to overtake an active previous operation', async () => {
    tx.clientOrderSubmission.findFirst.mockResolvedValue({ clientRevision: 1, state: 'PROCESSING' });
    await expect(acceptClientOrderSubmission(90, input({ ...payload, clientRevision: 2 })))
      .rejects.toMatchObject({ code: 'PREVIOUS_OPERATION_PENDING', retryable: true });
  });
  it('allows a corrected higher revision after review, preserving the old receipt', async () => {
    tx.clientOrderSubmission.findFirst.mockResolvedValue({ clientRevision: 1, state: 'NEEDS_REVIEW' });
    expect((await acceptClientOrderSubmission(90, input({ ...payload, clientRevision: 2 }))).clientRevision).toBe(2);
    expect(tx.clientOrderSubmission.create).toHaveBeenCalledTimes(1);
  });
  it('does not roll back valid neighbours of a malformed item', async () => {
    const batch = await acceptClientOrderSubmissionBatch(90, [input(), {}, input({ ...payload, clientRevision: 2 })]);
    expect(batch.results.map(r => r.accepted)).toEqual([true, false, true]);
  });
  it('scopes receipt polling to its authenticated owner', async () => {
    (prisma.clientOrderSubmission.findMany as jest.Mock).mockResolvedValue([]);
    await getClientOrderSubmissionStatuses(90, ['receipt-123']);
    expect(prisma.clientOrderSubmission.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 90, id: { in: ['receipt-123'] } } }));
  });
  it('accepts old server GUID operations into the same fast inbox without creating an Order', async () => {
    const guid = '5a74eabe-7124-4af7-a663-6809e70cc011';
    const body = { ...payload, legacyServerGuid: guid, legacyServerRevision: 3 };
    expect((await acceptClientOrderSubmission(90, { ...input(body), clientOrderId: `legacy-server:${guid}` })).accepted).toBe(true);
    expect(tx.order.findFirst).toHaveBeenCalledWith({ where: { guid, createdByUserId: 90, source: 'MANAGER_APP' }, select: { id: true } });
  });
  it('rejects an unowned or mismatched old GUID before acceptance', async () => {
    const guid = '5a74eabe-7124-4af7-a663-6809e70cc011';
    const body = { ...payload, legacyServerGuid: guid, legacyServerRevision: 3 };
    tx.order.findFirst.mockResolvedValue(null);
    await expect(acceptClientOrderSubmission(90, { ...input(body), clientOrderId: `legacy-server:${guid}` })).rejects.toMatchObject({ code: 'LEGACY_ORDER_NOT_FOUND' });
    expect(tx.clientOrderSubmission.create).not.toHaveBeenCalled();
  });
});
