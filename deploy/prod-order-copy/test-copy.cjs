// Executes actual source or deployed JS functions with isolated DB/transport adapters.
// Never imports the API bootstrap or connects to a database/1C.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const runtime = process.env.COPY_RUNTIME;
const service = fs.readFileSync(runtime || path.join(root, 'src/modules/clientOrders/clientOrders.service.ts'), 'utf8');
const shadow = fs.readFileSync(runtime ? path.join(path.dirname(runtime), 'clientOrders.invoiceShadow.js')
  : path.join(root, 'src/modules/clientOrders/clientOrders.invoiceShadow.ts'), 'utf8');
function functions(text, names) {
  const tree = ts.createSourceFile('input.ts', text, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name);
    return ts.transpileModule(node.getText(tree).replace(/^export\s+/, ''), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
  }).join('\n');
}
const code = functions(shadow, ['isInvoiceShadowOrder']) + functions(service, [
  'dateForCreatePayload', 'getCopyEntityGuid', 'buildClientOrderCopyPayload',
  'buildStoredClientOrderCopyItemData', 'copyStoredClientOrder', 'copyClientOrder',
]);
const number = value => ({ toString: () => String(value), toNumber: () => value });
function fullDetail(count = 3) {
  return { guid: 'source', organization: { guid: 'org' }, counterparty: { guid: 'customer' },
    warehouse: { guid: 'warehouse' }, agreement: { guid: 'agreement' }, contract: { guid: 'contract' },
    deliveryAddress: { guid: 'address' }, deliveryMethod: 'Delivery', currency: 'RUB',
    items: Array.from({ length: count }, (_, i) => ({ product: { guid: `product-${i}` },
      quantity: i + 1, price: 100, manualPrice: i === 0 ? 120 : null, isManualPrice: i === 0 })) };
}
function stored(overrides = {}) {
  return { guid: 'source', revision: 1, number1c: 'order-number', deliveryMethod: 'Delivery',
    last1cSnapshot: { invoiceShadow: true }, clientOrderId: null, syncState: 'SYNCED',
    counterpartyId: 'customer-id', organizationId: 'org-id', items: [], ...overrides };
}
function harness(source = stored(), detail = fullDetail(), failure) {
  const writes = [], reads = [], scopes = [];
  const select = (value, fields) => value == null ? null : Object.fromEntries(Object.entries(fields)
    .map(([k]) => [k, value[k]]));
  const tx = { order: {
    findFirst: async query => { scopes.push(query.where); return select(source, query.select); },
    create: async query => { writes.push(query.data); return { id: 'new-id', guid: 'new-guid', revision: 1 }; },
  } };
  const prisma = { order: { findFirst: async query => { scopes.push(query.where); return select(source, query.select); } },
    $transaction: async callback => callback(tx) };
  const ErrorCodes = { VALIDATION_ERROR: 'VALIDATION_ERROR' };
  class ClientOrdersError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  const context = {
    prisma, ErrorCodes, ClientOrdersError, DEFAULT_ORDER_CURRENCY: 'RUB',
    OrderSource: { MANAGER_APP: 'MANAGER_APP' }, OrderStatus: { DRAFT: 'DRAFT' },
    OrderSyncState: { DRAFT: 'DRAFT' }, OrderEventSource: { APP_MANAGER: 'APP_MANAGER' },
    Prisma: { Decimal: class { constructor(value) { this.value = value; } } },
    randomUUID: () => 'new-guid', now: () => new Date(),
    resolveDraftDeliveryMethod: value => value || 'Delivery',
    getManagerGuidForUser: async () => { throw new Error('Unexpected transport'); },
    resolveActiveTrackingOrderSnapshot: async () => null,
    appendOrderEvent: async () => {}, saveInvoicePreference: async () => {},
    getClientOrderByGuid: async (guid, owner) => { reads.push({ guid, owner }); if (failure) throw failure; return detail; },
    createClientOrder: async (owner, payload) => { writes.push({ owner, payload }); return { status: 'DRAFT', ...payload }; },
  };
  // Names emitted by the actual production TypeScript compiler.
  context.client_1 = context;
  context.client_2 = { default: prisma };
  context.node_crypto_1 = { randomUUID: context.randomUUID };
  context.clientOrders_delivery_1 = { resolveDraftDeliveryMethod: context.resolveDraftDeliveryMethod };
  context.orderEvents_1 = { appendOrderEvent: context.appendOrderEvent };
  context.apiResponse_1 = { ErrorCodes };
  vm.createContext(context);
  vm.runInContext(functions(shadow, ['isInvoiceShadowOrder']), context);
  context.clientOrders_invoiceShadow_1 = { isInvoiceShadowOrder: context.isInvoiceShadowOrder };
  vm.runInContext(code, context);
  return { context, writes, reads, scopes, copy: () => context.copyClientOrder('source', 95) };
}
for (const count of [1, 3]) test(`invoice-only source copies ${count} rows and full header`, async () => {
  const h = harness(stored(), fullDetail(count)); await h.copy();
  assert.equal(h.writes.length, 1);
  const payload = h.writes[0].payload;
  assert.ok(payload, 'must materialize full authorized detail, not clone bookkeeping');
  assert.equal(payload.items.length, count);
  for (const [field, value] of Object.entries({ organizationGuid: 'org', counterpartyGuid: 'customer',
    warehouseGuid: 'warehouse', agreementGuid: 'agreement', contractGuid: 'contract', deliveryAddressGuid: 'address' })) {
    assert.equal(payload[field], value);
  }
  assert.equal(payload.items[0].manualPrice, 120);
  assert.notEqual(payload.intent, 'SUBMIT');
  assert.deepEqual(h.reads, [{ guid: 'source', owner: 95 }]);
  for (const scope of h.scopes) assert.equal(scope.createdByUserId, 95);
});
test('empty ordinary local document fails before any write', async () => {
  const h = harness(stored({ last1cSnapshot: null }));
  await assert.rejects(h.copy(), /без товаров/); assert.equal(h.writes.length, 0); assert.equal(h.reads.length, 0);
});
test('empty full 1C detail cannot create an empty copy', async () => {
  const h = harness(stored(), fullDetail(0));
  await assert.rejects(h.copy(), /без товаров/); assert.equal(h.writes.length, 0);
});
test('invalid required source header cannot create a copy', async () => {
  const h = harness(stored(), { ...fullDetail(), organization: null });
  await assert.rejects(h.copy(), /организация/); assert.equal(h.writes.length, 0);
});
for (const status of [403, 404, 502]) test(`authorized detail failure ${status} is preserved without a copy`, async () => {
  const failure = Object.assign(new Error('source unavailable'), { status });
  const h = harness(stored(), fullDetail(), failure);
  await assert.rejects(h.copy(), error => error === failure); assert.equal(h.writes.length, 0);
});
test('queued or amended empty row must not masquerade as invoice bookkeeping', async () => {
  for (const overrides of [{ syncState: 'QUEUED' }, { clientOrderId: 'phone-order' }]) {
    const h = harness(stored(overrides)); await assert.rejects(h.copy(), /без товаров/);
    assert.equal(h.writes.length, 0); assert.equal(h.reads.length, 0);
  }
});
test('ordinary local copy keeps rows and manual price, resets automatic price, stays DRAFT', async () => {
  const item = { productId: 'p', quantity: number(2), quantityBase: number(2),
    basePrice: number(123), price: number(123), manualPrice: number(123), isManualPrice: true,
    lineAmount: number(246), discountPercent: number(0), appliedDiscountPercent: number(0) };
  const h = harness(stored({ last1cSnapshot: null, clientOrderId: 'local',
    warehouseId: 'wh', items: [item, { ...item, isManualPrice: false, manualPrice: null }] }));
  await h.copy(); assert.equal(h.writes.length, 1);
  const copy = h.writes[0]; assert.equal(copy.status, 'DRAFT'); assert.equal(copy.syncState, 'DRAFT');
  assert.equal(copy.warehouseId, 'wh'); assert.equal(copy.items.create.length, 2);
  assert.equal(copy.items.create[0].manualPrice, item.manualPrice);
  assert.equal(copy.items.create[1].manualPrice, null); assert.equal(copy.items.create[1].basePrice, null);
});
