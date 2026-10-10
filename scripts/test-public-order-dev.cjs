// Run only in the dev API container: node scripts/test-public-order-dev.cjs
// Creates a clearly-labelled, non-exportable demo draft and two isolated QA users.
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/prisma/client').default;
const base = 'http://127.0.0.1:3000';
async function main() {
  assert.equal(process.env.ORDER_SHARE_PUBLIC_ORIGIN, 'https://dev.leader-product.ru');
  assert(new URL(process.env.DATABASE_URL).pathname.endsWith('_dev'), 'DEV DATABASE ONLY');
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } });
  const basicRole = await prisma.role.findFirstOrThrow({ where: { name: { not: 'admin' }, parentRoleId: null }, orderBy: { id: 'asc' } });
  const owner = await prisma.user.upsert({ where: { email: 'order-share-qa@example.invalid' }, update: {}, create: {
    email: 'order-share-qa@example.invalid', firstName: 'Тестовый', lastName: 'Менеджер', roleId: adminRole.id,
    isActive: true, profileStatus: 'ACTIVE', currentProfileType: 'EMPLOYEE', employeeProfile: { create: { status: 'ACTIVE' } },
  } });
  const viewer = await prisma.user.upsert({ where: { email: 'order-share-viewer-qa@example.invalid' }, update: {}, create: {
    email: 'order-share-viewer-qa@example.invalid', firstName: 'QA', lastName: 'Контакты', roleId: basicRole.id,
    isActive: true, profileStatus: 'ACTIVE', currentProfileType: 'EMPLOYEE', employeeProfile: { create: { status: 'ACTIVE' } },
  } });
  const sign = (user, role) => jwt.sign({ userId: user.id, role, profileStatus: 'ACTIVE', permissions: [] }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '10m' });
  const admin = sign(owner, 'admin'); const ordinary = sign(viewer, basicRole.name);
  const call = async (path, token, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let result; try { result = JSON.parse(text); } catch { result = null; }
    return { status: response.status, data: result?.data, message: result?.message, etag: response.headers.get('ETag'), text };
  };
  let result = await call('/users/me/client-contacts', admin, 'PUT', { phones: [], telegramUrl: null, maxUrl: null });
  assert.equal(result.status, 200, result.message);
  result = await call('/users/me/client-contacts', admin, 'PUT', { phones: [{ label: 'Тестовый номер', number: '+70000000001' }], telegramUrl: null, maxUrl: null });
  assert.equal(result.status, 200, result.message);
  result = await call(`/users/${owner.id}/client-contacts`, ordinary, 'PUT', { phones: [] });
  assert.equal(result.status, 403, 'Non-admin must not edit another user');
  result = await call(`/users/${viewer.id}/client-contacts`, admin, 'PUT', { phones: [{ label: 'Рабочий', number: '+70000000001' }, { label: 'Дополнительный', number: '+70000000002' }], telegramUrl: '@example_manager', maxUrl: 'https://max.ru/u/example_manager' });
  assert.equal(result.status, 200, result.message); assert.equal(result.data.effective.phones.length, 2);
  result = await call('/users/me/client-contacts', ordinary); assert.equal(result.data.effective.phones.length, 2);
  result = await call('/users/me/client-contacts', ordinary, 'PUT', { phones: [], telegramUrl: 'javascript:alert(1)' }); assert.equal(result.status, 400);
  await prisma.user.update({ where: { id: viewer.id }, data: { clientContacts: { phones: [], telegramUrl: null, maxUrl: null } } });

  const cp = await prisma.counterparty.upsert({ where: { guid: 'qa-public-order-client' }, update: {}, create: { guid: 'qa-public-order-client', name: 'кафе «Мята» · тестовый заказ', isActive: false } });
  const images = await prisma.productImage.findMany({ where: { deletedAt: null, syncState: 'SYNCED', s3KeyPreview: { not: '' } }, select: { productGuid: true }, distinct: ['productGuid'], take: 40 });
  const products = await prisma.product.findMany({ where: { guid: { in: images.map(i => i.productGuid) }, isActive: true }, take: 4, orderBy: { name: 'asc' } });
  assert.equal(products.length, 4, 'Need four real catalog photos for responsive QA');
  let order = await prisma.order.findUnique({ where: { guid: 'qa-public-order-demo' } });
  if (!order) order = await prisma.order.create({ data: { guid: 'qa-public-order-demo', clientOrderId: 'qa-public-order-demo', clientRevision: 1,
    counterpartyId: cp.id, createdByUserId: owner.id, source: 'MANAGER_APP', status: 'DRAFT', syncState: 'DRAFT',
    comment: 'QA fixture. Never submit to 1C.', deliveryDate: new Date('2026-10-12T06:00:00Z'), currency: 'RUB', totalAmount: 8440,
    items: { create: products.map((p, i) => ({ productId: p.id, quantity: [3, 6, 2, 4][i], price: [1240, 420, 680, 210][i], lineAmount: [3720, 2520, 1360, 840][i] })) },
  } });
  const sharePath = `/api/order-sharing/${order.guid}/share`;
  result = await call(sharePath, admin, 'POST', {}); assert.equal(result.status, 200, result.message);
  let url = result.data.url; let token = new URL(url).hash.slice(1);
  assert.equal((await call(sharePath, admin, 'POST', {})).data.url, url, 'Stable link on repeat');
  const simultaneous = await Promise.all([call(sharePath, admin, 'POST', {}), call(sharePath, admin, 'POST', {})]);
  assert(simultaneous.every(r => r.status === 200 && r.data.url === url), 'Concurrent publication keeps the same token');
  assert.equal((await call('/public/order')).status, 410);
  assert.equal((await call('/public/order', admin)).status, 410, 'JWT is not a capability');
  result = await call('/public/order', token); assert.equal(result.status, 200, result.message);
  assert.equal(result.data.total, '8440.00'); assert.equal(result.data.items.length, 4);
  assert(!/receiptPrice|profit|stock|tracking|counterpartyGuid|productGuid|createdByUserId|QA fixture/.test(result.text));
  assert.equal((await call('/public/order', token, 'GET', undefined, { 'If-None-Match': result.etag })).status, 304);
  const photo = result.data.items.find(i => i.image)?.image;
  assert(photo, 'Photos available');
  const imageResponse = await fetch(base + '/public/order/images/' + photo.id, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(imageResponse.status, 200); assert(imageResponse.headers.get('content-type').startsWith('image/')); await imageResponse.arrayBuffer();
  const foreignImage = await prisma.productImage.findFirst({ where: { productGuid: { notIn: products.map(p => p.guid) }, syncState: 'SYNCED', deletedAt: null }, select: { id: true } });
  if (foreignImage) assert.equal((await call('/public/order/images/' + foreignImage.id, token)).status, 404);
  const rows = await prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
  const increment = Number(rows[0].price);
  await prisma.$transaction([prisma.orderItem.update({ where: { id: rows[0].id }, data: { quantity: Number(rows[0].quantity) + 1, lineAmount: Number(rows[0].lineAmount) + increment } }), prisma.order.update({ where: { id: order.id }, data: { totalAmount: 8440 + increment } })]);
  const changed = await call('/public/order', token); assert.equal(changed.data.total, (8440 + increment).toFixed(2)); assert.notEqual(changed.etag, result.etag);
  await prisma.$transaction([prisma.orderItem.update({ where: { id: rows[0].id }, data: { quantity: rows[0].quantity, lineAmount: rows[0].lineAmount } }), prisma.order.update({ where: { id: order.id }, data: { totalAmount: 8440 } })]);
  await call(sharePath, admin, 'DELETE'); assert.equal((await call('/public/order', token)).status, 410);
  result = await call(sharePath, admin, 'POST', {}); url = result.data.url;
  assert.notEqual(new URL(url).hash.slice(1), token); assert.equal((await call('/public/order', token)).status, 410);
  token = new URL(url).hash.slice(1);
  const link = await prisma.orderShareLink.findUnique({ where: { ownerId_orderGuid: { ownerId: owner.id, orderGuid: order.guid } } });
  await prisma.orderShareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(0) } });
  assert.equal((await call('/public/order', token)).status, 410);
  result = await call(sharePath, admin, 'POST', {}); url = result.data.url; token = new URL(url).hash.slice(1);
  assert.equal((await call('/users/me/client-contacts', token)).status, 401, 'Public token cannot enter employee API');
  const unchanged = await prisma.order.findUnique({ where: { id: order.id } }); assert.equal(unchanged.syncState, 'DRAFT'); assert.equal(unchanged.queuedAt, null);
  console.log(JSON.stringify({ passed: true, checks: ['own/admin contacts', 'RBAC', 'validation', 'stable/concurrent link', 'private field allowlist', 'image scope', 'ETag', 'live saved changes', 'revocation', 'expiration', 'no 1C queue'], demoUrl: url, orderGuid: order.guid, qaOwnerId: owner.id }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
