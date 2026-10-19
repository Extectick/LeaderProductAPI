jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  clientOrderSubmission: { findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() }, order: { findFirst: jest.fn() },
}, pool: { connect: jest.fn() } }));
jest.mock('../src/modules/clientOrders/clientOrders.service', () => ({
  putClientOrderByClientId: jest.fn(),
  ClientOrdersError: class extends Error { constructor(public status: number, public code: string, message: string, public details?: any) { super(message); } },
}));
import prisma, { pool } from '../src/prisma/client';
import { ClientOrdersError, putClientOrderByClientId } from '../src/modules/clientOrders/clientOrders.service';
import { processClientOrderSubmission, runClientOrderSubmissionsOnce, submissionFailure } from '../src/services/clientOrderSubmissionWorker';
import { submissionPayloadHash } from '../src/modules/clientOrders/clientOrderSubmissions';
import { ErrorCodes } from '../src/utils/apiResponse';
import { OrderIntegrityError } from '../src/modules/orders/orderIntegrity';
const payload = { organizationGuid: 'org', counterpartyGuid: 'customer', clientRevision: 1, intent: 'SUBMIT',
  items: [{ productGuid: 'product', lineGuid: 'line-guid-1234', quantity: 1, basePrice: 100 }], offlineReview: { pricePolicy: 'ASK' } };
let connection: any;
beforeEach(() => {
  jest.clearAllMocks();
  connection = { query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }), release: jest.fn() };
  (pool.connect as jest.Mock).mockResolvedValue(connection);
  (prisma.clientOrderSubmission.findUnique as jest.Mock).mockResolvedValue({ id: 'receipt-123', userId: 90,
    clientOrderId: 'client-order-123', clientRevision: 1, payload, payloadHash: submissionPayloadHash(payload), attempts: 0 });
  (prisma.clientOrderSubmission.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ isActive: true, deletedAt: null });
  (prisma.order.findFirst as jest.Mock).mockResolvedValue({ guid: 'canonical-guid' });
  (putClientOrderByClientId as jest.Mock).mockResolvedValue({ guid: 'canonical-guid' });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
describe('async submission materialization', () => {
  it('claims with a fencing token then materializes in the worker, not HTTP intake', async () => {
    await processClientOrderSubmission('receipt-123');
    expect(putClientOrderByClientId).toHaveBeenCalledWith(90, 'client-order-123', expect.objectContaining({ intent: 'SUBMIT', clientRevision: 1 }), { storedResultOnly: true });
    expect(prisma.clientOrderSubmission.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'receipt-123', leaseToken: expect.any(String) },
      data: expect.objectContaining({ state: 'QUEUED', orderGuid: 'canonical-guid' }) }));
    expect(connection.release).toHaveBeenCalled();
  });
  it('does not execute after another process acquired the order lock', async () => {
    connection.query.mockResolvedValue({ rows: [{ locked: false }] });
    await processClientOrderSubmission('receipt-123');
    expect(putClientOrderByClientId).not.toHaveBeenCalled(); expect(prisma.clientOrderSubmission.updateMany).not.toHaveBeenCalled();
  });
  it('does not execute after losing the compare-and-swap lease', async () => {
    (prisma.clientOrderSubmission.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    await processClientOrderSubmission('receipt-123'); expect(putClientOrderByClientId).not.toHaveBeenCalled();
  });
  it('rejects corruption of the frozen packet before contacting 1C', async () => {
    (prisma.clientOrderSubmission.findUnique as jest.Mock).mockResolvedValue({ id: 'receipt-123', userId: 90,
      clientOrderId: 'client-order-123', clientRevision: 1, payload, payloadHash: '0'.repeat(64), attempts: 0 });
    await processClientOrderSubmission('receipt-123'); expect(putClientOrderByClientId).not.toHaveBeenCalled();
    expect(prisma.clientOrderSubmission.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'REJECTED' }) }));
  });
  it('keeps unknown/transient failures durable with bounded retry, not a false success', async () => {
    (putClientOrderByClientId as jest.Mock).mockRejectedValue(new Error('network'));
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(null);
    await processClientOrderSubmission('receipt-123');
    expect(prisma.clientOrderSubmission.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'RETRY', nextAttemptAt: expect.any(Date) }) }));
  });
  it('recognizes a committed mutation after its response/detail failed', async () => {
    (putClientOrderByClientId as jest.Mock).mockRejectedValue(new Error('lost detail response after commit'));
    await processClientOrderSubmission('receipt-123');
    expect(prisma.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      createdByUserId: 90, clientOrderId: 'client-order-123', clientRevision: 1, clientPayloadHash: expect.any(String), submitRequestedAt: { not: null },
    }) }));
    expect(prisma.clientOrderSubmission.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'QUEUED' }) }));
  });
  it('does not treat an older SAVE as accepted submission', async () => {
    (putClientOrderByClientId as jest.Mock).mockResolvedValue({ guid: 'older-save' }); (prisma.order.findFirst as jest.Mock).mockResolvedValue(null);
    await processClientOrderSubmission('receipt-123');
    expect(prisma.clientOrderSubmission.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'REJECTED' }) }));
  });
  it('blocks disabled users without materialization', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ isActive: false }); await processClientOrderSubmission('receipt-123');
    expect(putClientOrderByClientId).not.toHaveBeenCalled();
    expect(prisma.clientOrderSubmission.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'REJECTED', errorCode: 'ACCOUNT_DISABLED' }) }));
  });
  it.each([ErrorCodes.PRICE_REVIEW_REQUIRED, ErrorCodes.STOCK_SHORTAGE, ErrorCodes.REFERENCE_STALE] as const)('retains business validation %s for user review', code => {
    expect(submissionFailure(new ClientOrdersError(409, code, 'review'))).toMatchObject({ state: 'NEEDS_REVIEW', code });
  });
  it('does not bypass destructive-change confirmation', () => {
    expect(submissionFailure(new OrderIntegrityError('Подтвердите изменение', { kind: 'ORDER_CHANGE_REVIEW_REQUIRED' })).state).toBe('NEEDS_REVIEW');
  });
  it('classifies stale content as review and preserves REFERENCE_STALE instead of the field label', () => {
    expect(submissionFailure(new OrderIntegrityError('Версия изменилась', { kind: 'ORDER_CONTENT_CONFLICT' })))
      .toMatchObject({ state: 'NEEDS_REVIEW', code: 'ORDER_CONTENT_CONFLICT' });
    expect(submissionFailure(new ClientOrdersError(409, ErrorCodes.REFERENCE_STALE, 'Выберите договор', { kind: 'Договор', guid: 'old' })))
      .toMatchObject({ state: 'NEEDS_REVIEW', code: 'REFERENCE_STALE', details: { kind: 'Договор', guid: 'old' } });
  });
  it('bounds concurrent materializations and continues after failure of one claim', async () => {
    (prisma.clientOrderSubmission.findMany as jest.Mock).mockResolvedValue([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);
    await runClientOrderSubmissionsOnce();
    expect(prisma.clientOrderSubmission.findUnique).toHaveBeenCalledTimes(3);
  });
});
