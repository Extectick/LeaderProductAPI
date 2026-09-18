import { assertOrderIntegrity, findOrderReductions, lockOrderMutation, orderContentToken, orderMutationDigest, OrderIntegrityError } from '../src/modules/orders/orderIntegrity';

const order = () => ({ id: 'order-1', status: 'CONFIRMED', revision: 2,
  organization: { guid: 'org' }, counterparty: { guid: 'client' },
  items: Array.from({ length: 7 }, (_, index) => ({ lineGuid: `line-${index}`, product: { guid: `p-${index}`, name: `Товар ${index}` },
    package: null, quantity: 2, quantityBase: 2, price: 360, basePrice: 360, isCancelled: false })) });
const body = (o = order()) => ({ items: o.items.map(i => ({ lineGuid: i.lineGuid, productGuid: i.product.guid, quantity: i.quantity })) });
const review = (o: any, b: any) => {
  try { assertOrderIntegrity(o, b, 37, 1000); throw new Error('Expected review'); }
  catch (e) { expect(e).toBeInstanceOf(OrderIntegrityError); return (e as OrderIntegrityError).details; }
};

describe('order content protection', () => {
  beforeAll(() => { process.env.ACCESS_TOKEN_SECRET = 'test-only-order-review-secret'; });
  it('incident: rejects 7 -> 5 without changing either list', () => {
    const o = order(); const b = body(o); b.items.splice(3, 2);
    const r = review(o, b);
    expect(r.kind).toBe('ORDER_CHANGE_REVIEW_REQUIRED');
    expect(r.changes.map((i: any) => i.lineGuid)).toEqual(['line-3', 'line-4']);
    expect(o.items).toHaveLength(7); expect(b.items).toHaveLength(5);
  });
  it('detects replacement with equal line count', () => {
    const o = order(); const b = body(o); b.items[0].productGuid = 'other';
    expect(findOrderReductions(o, b.items)).toHaveLength(1);
  });
  it.each(['quantity', 'cancel', 'package'])('requires review for %s', kind => {
    const o = order(); const b: any = body(o);
    if (kind === 'quantity') b.items[0].quantity = 1;
    if (kind === 'cancel') b.items[0].isCancelled = true;
    if (kind === 'package') b.items[0].packageGuid = 'new-package';
    expect(review(o, b).changes).toHaveLength(1);
  });
  it('allows unchanged and additive legacy payloads', () => {
    const o = order(); const b = body(o);
    assertOrderIntegrity(o, b, 37);
    b.items.push({ lineGuid: 'extra', productGuid: 'extra', quantity: 3 });
    assertOrderIntegrity(o, b, 37);
  });
  it('accepts confirmation only for exact payload, content, actor and lifetime', () => {
    const o = order(); const b: any = body(o); b.items.pop();
    const r = review(o, b);
    b.integrity = { baseContentToken: r.baseContentToken, confirmationToken: r.confirmationToken };
    expect(() => assertOrderIntegrity(o, b, 37, 2000)).not.toThrow();
    expect(() => assertOrderIntegrity(o, b, 38, 2000)).toThrow();
    expect(() => assertOrderIntegrity(o, b, 37, 700000)).toThrow();
    b.items[0].quantity = 1;
    expect(() => assertOrderIntegrity(o, b, 37, 2000)).toThrow();
  });
  it('rejects stale edits even when additive', () => {
    const o = order(); const b: any = body(o); b.integrity = { baseContentToken: orderContentToken(o) };
    o.items[0].quantity = 3;
    expect(review(o, b).kind).toBe('ORDER_CONTENT_CONFLICT');
  });
  it('status/revision and item order do not change content token', () => {
    const o = order(); const token = orderContentToken(o);
    o.status = 'QUEUED'; o.revision++; o.items.reverse(); o.items[0].product.name = 'Renamed';
    expect(orderContentToken(o)).toBe(token);
  });
  it('confirmation/transport metadata are not commercial content', () => {
    expect(orderMutationDigest({ ...body(), clientRevision: 2, integrity: { confirmationToken: 'a' } }))
      .toBe(orderMutationDigest({ ...body(), clientRevision: 3, integrity: { confirmationToken: 'b' } }));
  });
  it('fails closed while export owns the order', async () => {
    const tx: any = { $queryRaw: jest.fn().mockResolvedValue([{ locked: false }]) };
    await expect(lockOrderMutation(tx, 'guid')).rejects.toThrow('сейчас отправляется');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it('blocks mutations between ambiguous network retries', async () => {
    const tx: any = { $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'order-1', revision: 1 }) },
      orderEvent: { findFirst: jest.fn().mockResolvedValue({ id: 'packet-1' }) } };
    await expect(lockOrderMutation(tx, 'guid')).rejects.toThrow('не подтверждён');
  });
});
