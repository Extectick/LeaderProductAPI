// Run in an API image against the isolated partial PostgreSQL production copy.
const assert = require('node:assert/strict');
const { randomBytes, randomInt, randomUUID } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { prisma, pool } = require('../dist/prisma/client');
const { saveDraftBackup: save, getDraftBackup: read, draftBackupHash: hash, DraftBackupConflict } =
  require('../dist/modules/clientOrders/clientOrderDraftBackups');

async function main() {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/lp_audit_copy');
  assert.equal((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name, 'lp_audit_copy');
  const [{ toast }] = await prisma.$queryRaw`SELECT reltoastrelid::regclass::text AS toast
    FROM pg_class WHERE oid='public."ClientOrderDraftBackup"'::regclass`;
  assert.match(toast, /^pg_toast\.pg_toast_[0-9]+$/);
  async function chunks() {
    const ids = await prisma.$queryRaw`SELECT DISTINCT chunk_id::text AS id FROM ${Prisma.raw(toast)}`;
    return new Set(ids.map(row => row.id));
  }
  const existing = await prisma.clientOrderDraftBackup.findFirst({ where: { userId: { gt: 0 } } });
  assert.ok(existing);
  const uid = -randomInt(10_000, 1_000_000_000);
  const role = await prisma.role.create({data:{name:'draft-fixture-'+randomUUID()}});
  try {
    await prisma.user.create({data:{id:uid,roleId:role.id}});
    const id = randomUUID(), idLegacy=randomUUID();
    const where = {userId_clientOrderId: {userId:uid, clientOrderId:id}};
    const payload = {lines:[randomBytes(25_000).toString('hex')], geoEvents:[{x:1}]};
    const order = {lines:[randomBytes(21_000).toString('hex')]};
    const differences = (current,previous) => [...current].filter(k=>!previous.has(k));
    const without = await chunks();
    const first = await save(uid,id,{clientRevision:3,payload,order});
    const initialChunks = await chunks();
    const originals = differences(initialChunks,without);
    assert.equal(originals.length,2, 'both JSONB fields must be physically toasted');
    await prisma.clientOrderDraftBackup.update({where, data:{review:{state:'pending'},submittedOrderGuid:'sent-example'}});
    await new Promise(r=>setTimeout(r,10));
    const same = await Promise.all([save(uid,id,{clientRevision:3,payload,order}),save(uid,id,{clientRevision:3,payload})]);
    assert.ok(same.every(r=>r.savedAt>first.savedAt && r.submittedOrderGuid==='sent-example'));
    assert.deepEqual(await chunks(),initialChunks,'identical retries rewrote a TOAST value');
    let row = await read(uid,id);
    assert.deepEqual(row.orderSnapshot,order);
    assert.deepEqual(row.review,{state:'pending'});

    const movedGeo = {...payload,geoEvents:[{x:2}]};
    assert.equal(hash(movedGeo),hash(payload));
    await save(uid,id,{clientRevision:3, payload:movedGeo,order});
    const geoChunks=await chunks();
    assert.equal(differences(geoChunks,initialChunks).length,1);
    assert.equal(differences(initialChunks,geoChunks).length,1);
    row = await read(uid,id);
    assert.deepEqual(row.payload,movedGeo);
    assert.equal(row.submittedOrderGuid,'sent-example');
    const nextOrder={...order,memo:'updated'};
    await save(uid,id,{clientRevision:3,payload:movedGeo,order:nextOrder});
    const orderChunks=await chunks();
    assert.equal(differences(orderChunks,geoChunks).length,1);
    assert.equal(differences(geoChunks,orderChunks).length,1);
    assert.ok(differences(geoChunks,initialChunks).every(k=>orderChunks.has(k)),'changed order rewrote identical payload');
    assert.deepEqual((await read(uid,id)).orderSnapshot,nextOrder);

    await assert.rejects(save(uid,id,{clientRevision:2,payload}),DraftBackupConflict);
    await assert.rejects(save(uid,id,{clientRevision:3,payload:{lines:['different']}}),DraftBackupConflict);
    const concurrent=await Promise.allSettled([
      save(uid,id,{clientRevision:4,payload:movedGeo}),
      save(uid,id,{clientRevision:4,payload:{lines:['new quantity']}}),
    ]);
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
    assert.ok(concurrent.find(r=>r.status==='rejected').reason instanceof DraftBackupConflict);
    row=await read(uid,id);
    assert.equal(row.clientRevision,4);
    assert.deepEqual(row.orderSnapshot,nextOrder);
    assert.equal(row.review,null);
    assert.equal(row.submittedOrderGuid,null);
    await save(uid,id,{clientRevision:5,payload:row.payload});
    const native = await save(uid,id,{clientRevision:5,payload:row.payload});
    assert.equal(native.clientRevision,5);
    assert.equal((await read(uid,id)).orderSnapshot.memo,'updated');

    await prisma.clientOrderDraftBackup.create({data:{clientOrderId:idLegacy,userId:uid,clientRevision:existing.clientRevision,
      payload:existing.payload,payloadHash:hash(existing.payload),...(existing.orderSnapshot && {orderSnapshot:existing.orderSnapshot}),
      submittedOrderGuid:existing.submittedOrderGuid}});
    const beforeLegacy=await chunks();
    const result=await save(uid,idLegacy,{clientRevision:existing.clientRevision,payload:existing.payload});
    const afterLegacy=await chunks();
    assert.deepEqual(afterLegacy,beforeLegacy);
    assert.equal(result.submittedOrderGuid,existing.submittedOrderGuid);
    assert.deepEqual((await read(uid,idLegacy)).orderSnapshot,existing.orderSnapshot);
    console.log(JSON.stringify({copy:true,twoExternalJsonFields:true,identicalRetriesNewToastValues:0,
      geoOnlyReplaced:1,orderOnlyReplaced:1,omittedOrderPreserved:true,advancedRevision:true,
      concurrentSameRevisionConflict:true,reviewAndSubmittedState:true,copiedHistoricalPayload:true}));
  } finally {
    await prisma.user.deleteMany({where:{id:uid}});
    await prisma.role.deleteMany({where:{id:role.id}});
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;})
  .finally(async()=>{await prisma.$disconnect();await pool.end();});
