// Dev-only smoke test. Keeps the previously shared demo link unchanged.
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/prisma/client').default;
const { decryptShareToken } = require('../dist/modules/orderShare/orderShare.model');
const base = 'http://127.0.0.1:3000';
async function main() {
  assert.equal(process.env.ORDER_SHARE_PUBLIC_ORIGIN, 'https://dev.leader-product.ru');
  assert(new URL(process.env.DATABASE_URL).pathname.endsWith('_dev'), 'DEV DATABASE ONLY');
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'order-share-qa@example.invalid' } });
  const original = await prisma.order.findUniqueOrThrow({ where: { guid: 'qa-public-order-demo' }, include: { items: true } });
  assert.equal(original.createdByUserId, owner.id);
  const previous = await prisma.orderShareLink.findUniqueOrThrow({ where: { ownerId_orderGuid: { ownerId: owner.id, orderGuid: original.guid } } });
  const oldToken = decryptShareToken(previous.tokenEncrypted);
  assert.equal(oldToken.length, 43, 'Requires the earlier long demo link');
  const read = token => fetch(base + '/public/order', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await read(oldToken)).status, 200, 'Old link still works');
  const guid = 'qa-public-order-short-link';
  let order = await prisma.order.findUnique({ where: { guid } });
  if (!order) order = await prisma.order.create({ data: {
    guid, clientOrderId: guid, clientRevision: 1, counterpartyId: original.counterpartyId,
    createdByUserId: owner.id, source: 'MANAGER_APP', status: 'DRAFT', syncState: 'DRAFT',
    comment: 'QA fixture. Never submit to 1C.', deliveryDate: original.deliveryDate, currency: original.currency, totalAmount: original.totalAmount,
    items: { create: original.items.map(row => ({ productId: row.productId, quantity: row.quantity, price: row.price, lineAmount: row.lineAmount })) },
  } });
  assert.equal(order.createdByUserId, owner.id);
  assert.equal(order.syncState, 'DRAFT'); assert.equal(order.queuedAt, null);
  const auth = jwt.sign({ userId: owner.id, role: 'admin', profileStatus: 'ACTIVE', permissions: [] }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '5m' });
  const publish = () => fetch(base + `/api/order-sharing/${guid}/share`, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: '{}' });
  const response = await publish(); assert.equal(response.status, 200);
  const body = await response.json(); const token = new URL(body.data.url).hash.slice(1);
  assert.equal(token.length, 12);
  const publicResponse = await read(token); assert.equal(publicResponse.status, 200);
  const data = (await publicResponse.json()).data;
  const photo = data.items.find(row => row.image)?.image; assert(photo);
  const photoResponse = await fetch(base + `/public/order/images/${photo.id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(photoResponse.status, 200); await photoResponse.arrayBuffer();
  assert.equal((await (await publish()).json()).data.url, body.data.url, 'Stable short link');
  assert.equal((await read(oldToken)).status, 200, 'Earlier demo unaffected');
  assert.equal((await read('a'.repeat(8))).status, 410);
  assert.equal((await read('a'.repeat(12))).status, 410, 'Unknown short code rejected');
  console.log(JSON.stringify({ passed: true, newCodeLength: token.length, legacyCodeLength: oldToken.length, draftQueued: false, demoUrl: body.data.url }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
