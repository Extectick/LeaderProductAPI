// Run from an API image against an isolated partial production copy, never a live database.
// The copy needs the schema plus Product, PriceType, Warehouse, Organization,
// SellingPrice and ManagerStockReservation rows; other tables start empty.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, pool } = require('../dist/prisma/client');
const handlers = require('../dist/modules/onec/onec.controllers');
const offline = require('../dist/modules/clientOrders/offlineClientOrders.service');
const snapshots = {};

async function post(handler, items, status = 200) {
  let actualStatus = 200, body;
  await handler({ body: { items, secret: 'fixture-only' } }, {
    status(value) { actualStatus = value; return this; },
    json(value) { body = value; return this; },
  });
  assert.equal(actualStatus, status);
  assert.equal(body.count, items.length);
  return body;
}
const state = entity => prisma.offlineDatasetState.findUniqueOrThrow({
  where: { scopeKey_entity: { scopeKey: 'client-orders', entity } },
});
const markers = entity => prisma.offlineDatasetChange.count({ where: { scopeKey: 'client-orders', entity } });
const manifest = async (user, entity) => (await offline.getOfflineManifest(user.id)).entities.find(entry => entry.entity === entity);
const deltas = (user, prev) => offline.getOfflineChanges(user.id, prev.entity, { afterRevision: BigInt(prev.revision), epoch: prev.epoch, limit: 100 });
const reserve = handlers.handleManagerStockBatch;
const price = handlers.handleSellingPricesBatch;

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /^\/LeaderAPI_marker_replay_\d+$/);
  assert.equal((await prisma.$queryRaw`SELECT current_database() db`)[0].db, target.pathname.slice(1));
  assert.equal(await prisma.user.count(), 0);
  assert.equal(await prisma.offlineDatasetState.count(), 0);
  const role = await prisma.role.create({ data: { name: 'copied-db-fixture' } });
  const guidA = randomUUID(), guidB = randomUUID();
  const user = guid => prisma.user.create({ data: { roleId: role.id, employeeProfile: { create: { onecUserGuid: guid } } } });
  const [A, B] = await Promise.all([user(guidA), user(guidB)]);
  const stockRows = await prisma.managerStockReservation.findMany({
    include: { warehouse: true, product: true, organization: true },
  });
  assert.ok(stockRows.length > 10);
  const stockInput = stockRows.map(r => ({ syncKey: r.syncKey, managerGuid: r.managerGuid, productGuid: r.product.guid,
    warehouseGuid: r.warehouse.guid, organizationGuid: r.organization?.guid ?? null, reserved: +r.reserved }));
  await Promise.all([post(reserve, stockInput), post(reserve, [...stockInput].reverse())]);
  assert.equal(await markers('manager-stock'), 0);
  const verified = (await state('manager-stock')).lastSourceUpdateAt;
  assert.ok(verified instanceof Date);
  const priceRows = await prisma.sellingPrice.findMany({ where:{sourceRegister:{in:['ЦеныНоменклатуры','ЦеныНоменклатуры25']}},
    include: { priceType: true, product: true }, take: 400 });
  assert.ok(priceRows.length > 0);
  const priceInput = priceRows.map(r => ({syncKey:r.syncKey,productGuid:r.product.guid,priceTypeGuid:r.priceType.guid,
    sourceRegister:r.sourceRegister,price:+r.price,currency:r.currency,packageGuid:r.packageGuid,characteristicGuid:r.characteristicGuid,
    priority:r.priority,startDate:r.startDate,endDate:r.endDate,isActive:r.isActive,...(r.minQty != null ? {minQty:+r.minQty}: {})}));
  await Promise.all([post(price,priceInput),post(price,priceInput)]);
  assert.equal(await markers('selling-prices'),0);
  snapshots.replayed = { reservations:stockInput.length, sellingPrices:priceInput.length, concurrentCopies:2, markers:0 };
  const key = 'fixture/' + randomUUID();
  const base = stockInput.find((_, i) => stockRows[i].warehouse.isActive && stockRows[i].product.isActive && (!stockRows[i].organization || stockRows[i].organization.isActive));
  assert.ok(base);
  const record = { ...base, syncKey: key, managerGuid:guidA,reserved:1.50045 };
  const init = await manifest(A,'manager-stock');
  await Promise.all([post(reserve,[record]),post(reserve,[record])]);
  assert.equal(await markers('manager-stock'),1);
  const first = await manifest(A,'manager-stock');
  assert.equal((await deltas(A,init)).changes[0].item.syncKey,key);
  assert.equal(+((await offline.getOfflineSnapshot(A.id,'manager-stock',{limit:20})).items[0].reserved),1.5);
  const other = await manifest(B,'manager-stock');
  const origRow = await prisma.managerStockReservation.findUniqueOrThrow({where:{syncKey:key}});
  const before = await state('manager-stock');
  await post(reserve,[{...record,reserved:1.5,sourceUpdatedAt:new Date()}]);
  assert.equal(await markers('manager-stock'),1);
  const checked = await state('manager-stock');
  assert.equal(checked.currentRevision,before.currentRevision);
  assert.ok(checked.lastSourceUpdateAt > before.lastSourceUpdateAt);
  assert.equal((await manifest(A,'manager-stock')).revision, first.revision);
  assert.equal((await deltas(A,first)).changes.length,0);
  const moved = {...record, managerGuid:guidB,reserved:3.5};
  await Promise.all([post(reserve,[moved]),post(reserve,[moved])]);
  assert.equal(await markers('manager-stock'),2);
  await manifest(A,'manager-stock');
  assert.equal((await deltas(A,first)).changes[0].operation,'DELETE');
  const afterMove = await manifest(B,'manager-stock');
  assert.equal((await deltas(B,other)).changes[0].operation,'UPSERT');
  assert.equal((await offline.getOfflineSnapshot(A.id,'manager-stock',{limit:20})).items.length,0);
  await post(reserve,[{...moved,reserved:0}]);
  assert.equal(await markers('manager-stock'),3);
  await manifest(B,'manager-stock');
  assert.equal((await deltas(B,afterMove)).changes[0].operation,'DELETE');
  assert.equal((await prisma.managerStockReservation.findUniqueOrThrow({where:{syncKey:key}})).id,origRow.id);
  await post(reserve,[{...moved,reserved:0,warehouseGuid:'missing-fixture'}, {...moved,reserved:0}],422);
  assert.equal(await markers('manager-stock'),3);
  snapshots.stock = { duplicateStable:true, confirmedAtAdvanced:true, roundedDecimal:true, movedBetweenManagers:true, revokedFromOldAccount:true, zeroRemoved:true, oldCursorReadable:true, invalidItem422:true };

  const pkey = 'fixture-price/' + randomUUID();
  const example = {...priceInput[0],syncKey:pkey,price:8.12345,minQty:5};
  await Promise.all([post(price,[example]),post(price,[example])]);
  assert.equal(await markers('selling-prices'),1);
  const priceRow = await prisma.sellingPrice.findUniqueOrThrow({where:{syncKey:pkey}});
  assert.equal(+priceRow.price,8.1235);
  const {minQty,...omitMin} = example;
  await post(price,[{...omitMin,price:8.1235}]);
  assert.equal(+((await prisma.sellingPrice.findUniqueOrThrow({where:{syncKey:pkey}})).minQty),5);
  assert.equal(await markers('selling-prices'),1);
  await post(price,[{...example,price:9,minQty:7},{...omitMin,price:10}]);
  const changedPrice=await prisma.sellingPrice.findUniqueOrThrow({where:{syncKey:pkey}});
  assert.equal(+changedPrice.price,10);
  assert.equal(+changedPrice.minQty,7);
  assert.equal(changedPrice.id,priceRow.id);
  assert.equal(await markers('selling-prices'),2);
  await post(price,[{...example,price:10,minQty:7,isActive:!example.isActive}]);
  assert.equal(await markers('selling-prices'),3);
  snapshots.prices={duplicateStable:true, decimalScaleMatchesDb:true,duplicateKeysLastWins:true,omittedMinQtyPreserved:true,deactivationVisible:true};

  const oldEpoch=(await state('manager-stock')).epoch;
  let cleared;
  await handlers.handleEntityClear({params:{entity:'manager-stock'}},{json(value){cleared=value;},status(){return this;}});
  assert.ok(cleared.success);
  assert.notEqual((await state('manager-stock')).epoch,oldEpoch);
  assert.equal(await markers('manager-stock'),0);
  assert.equal(await prisma.managerStockReservation.count(),0);
  snapshots.atomicClear = true;
  console.log(JSON.stringify(snapshots));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();await pool.end();});
