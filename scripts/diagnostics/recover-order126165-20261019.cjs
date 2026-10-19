const crypto = require('node:crypto');
const fs = require('node:fs');
const { default: db, pool } = require('/app/dist/prisma/client');
const service = require('/app/dist/modules/clientOrders/clientOrders.service');
const { clientOrderMutationSchema } = require('/app/dist/modules/clientOrders/clientOrders.schemas');
const inbox = require('/app/dist/modules/clientOrders/clientOrderSubmissions');
const { draftBackupHash } = require('/app/dist/modules/clientOrders/clientOrderDraftBackups');
const { getLiveClientOrder } = require('/app/dist/modules/clientOrders/clientOrders.onecLive');
const { orderContentToken } = require('/app/dist/modules/orders/orderIntegrity');
const USER = 99;
const CLIENT = '007955a1-8912-48ee-8737-b109ee766cab';
const GUID = '33d4c1cc-d71d-48c4-b634-a1eeb15a7dbf';
const ONEC = '7d3cdfb5-cb82-11f1-9d3a-f1cbadb7fc65';
const NUMBER = 'НОУТ-126165';
const phase = process.env.RECOVERY_PHASE || 'inspect';
const deadline = setTimeout(() => process.exit(2), 300000);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const log = value => console.log(JSON.stringify(value));
const close = async () => { await db.$disconnect(); await pool.end(); clearTimeout(deadline); };
async function target() {
  const order = await service.getStoredClientOrderForSubmission(GUID, USER);
  if (order.createdByUser?.id !== USER || order.clientOrderId !== CLIENT || order.number1c !== NUMBER
    || order.source !== 'MANAGER_APP') throw Error('Order identity/owner guard');
  return order;
}
async function originals() {
  const receipts = await db.clientOrderSubmission.findMany({ where: { userId: USER, clientOrderId: CLIENT }, orderBy: { clientRevision: 'desc' } });
  const backup = await db.clientOrderDraftBackup.findUnique({ where: { userId_clientOrderId: { userId: USER, clientOrderId: CLIENT } } });
  if (!receipts.length) throw Error('Missing original operation');
  for (const r of receipts) if (r.payload && inbox.submissionPayloadHash(r.payload) !== r.payloadHash) throw Error('Immutable packet hash mismatch');
  const latest = receipts[0];
  if (backup && backup.clientRevision === latest.clientRevision && draftBackupHash(backup.payload) !== draftBackupHash(latest.payload)) throw Error('Same revision has differing contents');
  const source = backup && backup.clientRevision >= latest.clientRevision
    ? { kind: 'backup', revision: backup.clientRevision, payload: backup.payload }
    : { kind: 'receipt', revision: latest.clientRevision, payload: latest.payload };
  if (!source.payload || !Array.isArray(source.payload.items)) throw Error('Latest saved contents unavailable');
  return { receipts, backup, source };
}
async function liveOrder(order) {
  const profile = await db.employeeProfile.findUnique({ where: { userId: USER }, select: { onecUserGuid: true } });
  if (!profile?.onecUserGuid) throw Error('Missing manager');
  const live = await getLiveClientOrder(ONEC, { managerGuid: profile.onecUserGuid, appGuid: GUID });
  if (live.guid !== ONEC || live.appGuid?.toLowerCase() !== GUID || live.number1c !== NUMBER) throw Error('Live 1C identity mismatch');
  return live;
}
function businessLines(order) {
  return order.items.map(i => ({ lineGuid: i.lineGuid, productGuid: i.product?.guid,
    quantity: Number(i.quantity), price: Number(i.price), amount: Number(i.lineAmount), cancelled: !!i.isCancelled }))
    .sort((a, b) => a.lineGuid.localeCompare(b.lineGuid));
}
function summary(order) {
  return { guid: order.guid, number1c: order.number1c, clientRevision: order.clientRevision,
    revision: order.revision, rows: order.items.length, amount: Number(order.totalAmount),
    status: order.status, syncState: order.syncState, posted: order.isPostedIn1c,
    hasRealization: order.hasRealization, lastExportError: order.lastExportError,
    last1cError: order.last1cError, draftReview: order.draftReview };
}
(async () => {
  if (process.env.NODE_ENV !== 'production' || new URL(process.env.DATABASE_URL).pathname !== '/LeaderAPI'
    || !String(process.env.ONEC_LP_APP_BASE_URL).toLowerCase().includes('torg2026')) throw Error('Wrong production target');
  if (!['inspect'].includes(phase)) throw Error('Unsupported recovery phase');
  const user = await db.user.findUnique({ where: { id: USER }, select: { isActive: true, deletedAt: true } });
  if (!user?.isActive || user.deletedAt) throw Error('Inactive owner');
  const order = await target(), saved = await originals(), live = await liveOrder(order);
  const source = saved.source;
  const nextRevision = Math.max(source.revision, order.clientRevision || 0) + 1;
  const body = clientOrderMutationSchema.parse({ ...source.payload, clientRevision: nextRevision, intent: 'SUBMIT', offlineReview: { pricePolicy: 'ASK' } });
  const review = await service.previewClientOrderAmendment(USER, CLIENT, body);
  const apiLines = businessLines(order), liveLines = businessLines(live);
  log({ stage: 'current-order', order: summary(order), live: { guid: live.guid, appGuid: live.appGuid, number1c: live.number1c,
    rows: live.items.length, amount: live.totalAmount, posted: live.isPostedIn1c, status: live.status, hasRealization: live.hasRealization },
    exactLinesMatch: hash(apiLines) === hash(liveLines), apiLines, liveLines });
  log({ stage: 'saved-operations', receipts: saved.receipts.map(r => ({ id: r.id, revision: r.clientRevision,
    state: r.state, rows: r.payload?.items?.length, payloadHash: r.payloadHash, errorCode: r.errorCode, acceptedAt: r.acceptedAt })),
    backup: saved.backup && { revision: saved.backup.clientRevision, updatedAt: saved.backup.updatedAt,
      rows: saved.backup.payload?.items?.length, snapshotAmount: saved.backup.orderSnapshot?.totalAmount, review: saved.backup.review } });
  log({ stage: 'latest-proposal', source: source.kind, sourceRevision: source.revision,
    sourceHash: inbox.submissionPayloadHash(source.payload), commercialHash: draftBackupHash(source.payload), nextRevision,
    rows: body.items.length, estimatedAmount: body.items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.manualPrice ?? i.basePrice ?? 0) * (1 - Number(i.discountPercent || 0) / 100), 0),
    baseContentToken: review.baseContentToken, confirmationRequired: review.requiresConfirmation,
    reductionsRequireApproval: !!review.confirmationToken, changes: review.changes,
    header: { deliveryMethod: body.deliveryMethod, deliveryDate: body.deliveryDate, comment: body.comment },
    items: body.items.map(i => ({ lineGuid: i.lineGuid, productGuid: i.productGuid, quantity: i.quantity, manualPrice: i.manualPrice, basePrice: i.basePrice })) });
})().catch(e => { log({ failure: e.message, code: e.code || e.details?.kind, details: e.details ? { ...e.details, confirmationToken: undefined, baseContentToken: undefined } : undefined }); process.exitCode = 1; }).finally(close);
