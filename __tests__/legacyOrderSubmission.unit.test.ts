jest.mock('../src/modules/clientOrders/clientOrders.service', () => ({
  getStoredClientOrderForSubmission: jest.fn(), updateClientOrder: jest.fn(), submitClientOrder: jest.fn(),
  ClientOrdersError: class extends Error { constructor(public status: number, public code: string, message: string, public details?: any) { super(message); } },
}));
import { getStoredClientOrderForSubmission, updateClientOrder, submitClientOrder } from '../src/modules/clientOrders/clientOrders.service';
import { clientOrderMutationSchema } from '../src/modules/clientOrders/clientOrders.schemas';
import { legacySubmissionMatches, materializeLegacyOrderSubmission } from '../src/modules/clientOrders/legacyOrderSubmission';
const payload = clientOrderMutationSchema.parse({ organizationGuid: 'org', counterpartyGuid: 'client', clientRevision: 2, intent: 'SUBMIT',
  deliveryDate: '2026-10-17T00:00:00Z', currency: 'RUB', items: [{ lineGuid: 'line-guid-1', productGuid: 'product', quantity: 2, manualPrice: 10 }] });
const raw = { ...payload, legacyServerGuid: 'original-guid', legacyServerRevision: 3 };
const saved = (changes: any = {}) => ({ guid: 'original-guid', createdByUser: { id: 90 }, revision: 3, status: 'DRAFT', syncState: 'DRAFT',
  organization: { guid: 'org' }, counterparty: { guid: 'client' }, deliveryDate: payload.deliveryDate, currency: 'RUB',
  items: [{ lineGuid: 'line-guid-1', product: { guid: 'product' }, quantity: 2, manualPrice: 10 }], ...changes });
beforeEach(() => {
  jest.clearAllMocks();
  (getStoredClientOrderForSubmission as jest.Mock).mockResolvedValue(saved());
  (submitClientOrder as jest.Mock).mockResolvedValue(saved({ revision: 4, status: 'QUEUED', syncState: 'QUEUED' }));
});
it('submits the existing GUID from durable matching SAVE without rewriting or creating a replacement', async () => {
  expect(legacySubmissionMatches(payload, saved())).toBe(true);
  await materializeLegacyOrderSubmission(90, raw, payload);
  expect(updateClientOrder).not.toHaveBeenCalled();
  expect(submitClientOrder).toHaveBeenCalledWith('original-guid', 90, expect.objectContaining({ revision: 3 }));
});
it('accepts a server delivery default only when legacy input made no explicit choice', () => {
  expect(legacySubmissionMatches(payload, saved({ deliveryMethod: 'ДоКлиента' }))).toBe(true);
  expect(legacySubmissionMatches({ ...payload, deliveryMethod: 'Самовывоз' }, saved({ deliveryMethod: 'ДоКлиента' }))).toBe(false);
  expect(legacySubmissionMatches({ ...payload, deliveryMethod: 'Самовывоз' }, saved({ deliveryMethod: 'Самовывоз' }))).toBe(true);
});
it('resumes a lost SAVE at the newer server revision only if the entire input matches', async () => {
  (getStoredClientOrderForSubmission as jest.Mock).mockResolvedValue(saved({ revision: 4 }));
  await materializeLegacyOrderSubmission(90, raw, payload);
  expect(updateClientOrder).not.toHaveBeenCalled();
  expect(submitClientOrder).toHaveBeenCalledWith('original-guid', 90, expect.objectContaining({ revision: 4 }));
});
it('does not rebase differing lines at a newer revision', async () => {
  (getStoredClientOrderForSubmission as jest.Mock).mockResolvedValue(saved({ revision: 4, items: [] }));
  await expect(materializeLegacyOrderSubmission(90, raw, payload)).rejects.toMatchObject({ details: { kind: 'LEGACY_DRAFT_CONFLICT' } });
  expect(updateClientOrder).not.toHaveBeenCalled(); expect(submitClientOrder).not.toHaveBeenCalled();
});
it('retains explicit integrity/stock errors before a SAVE committed', async () => {
  (getStoredClientOrderForSubmission as jest.Mock).mockResolvedValue(saved({ items: [] }));
  const failure = new Error('confirmation required'); (updateClientOrder as jest.Mock).mockRejectedValue(failure);
  await expect(materializeLegacyOrderSubmission(90, raw, payload)).rejects.toBe(failure);
  expect(submitClientOrder).not.toHaveBeenCalled();
});
it('proves the exact SAVE after update detail failed, then resumes submit', async () => {
  (getStoredClientOrderForSubmission as jest.Mock).mockResolvedValueOnce(saved({ items: [] })).mockResolvedValueOnce(saved({ revision: 4 }));
  (updateClientOrder as jest.Mock).mockRejectedValue(new Error('lost SAVE detail'));
  await materializeLegacyOrderSubmission(90, raw, payload);
  expect(submitClientOrder).toHaveBeenCalledWith('original-guid', 90, expect.objectContaining({ revision: 4 }));
});
it('does not repeat an already accepted SUBMIT', async () => {
  (getStoredClientOrderForSubmission as jest.Mock).mockResolvedValue(saved({ revision: 4, status: 'QUEUED', syncState: 'QUEUED' }));
  await materializeLegacyOrderSubmission(90, raw, payload);
  expect(updateClientOrder).not.toHaveBeenCalled(); expect(submitClientOrder).not.toHaveBeenCalled();
});
it('recovers a committed SUBMIT from PostgreSQL after lost detail reply', async () => {
  (getStoredClientOrderForSubmission as jest.Mock).mockResolvedValueOnce(saved()).mockResolvedValueOnce(saved({ revision: 4, status: 'QUEUED', syncState: 'QUEUED' }));
  (submitClientOrder as jest.Mock).mockRejectedValue(new Error('lost ACK'));
  expect((await materializeLegacyOrderSubmission(90, raw, payload)).guid).toBe('original-guid');
});
it('does not infer success from a newer SAVE without SUBMIT', async () => {
  const failure = new Error('lost ACK'); (submitClientOrder as jest.Mock).mockRejectedValue(failure);
  (getStoredClientOrderForSubmission as jest.Mock).mockResolvedValueOnce(saved()).mockResolvedValueOnce(saved({ revision: 4 }));
  await expect(materializeLegacyOrderSubmission(90, raw, payload)).rejects.toBe(failure);
});
it.each([{ guid: 'foreign' }, { createdByUser: { id: 91 } }, { revision: 2 }])('fails closed for wrong identity or stale source %j', async changes => {
  (getStoredClientOrderForSubmission as jest.Mock).mockResolvedValue(saved(changes));
  await expect(materializeLegacyOrderSubmission(90, raw, payload)).rejects.toThrow('изменён');
  expect(submitClientOrder).not.toHaveBeenCalled();
});
it.each([{ quantity: 3 }, { manualPrice: 11 }, { product: { guid: 'other' } }, { package: { guid: 'other' } }, { comment: 'different' }, { isCancelled: true }])('never discards different legacy line %j', changes => {
  const order = saved(); order.items[0] = { ...order.items[0], ...changes };
  expect(legacySubmissionMatches(payload, order)).toBe(false);
});
