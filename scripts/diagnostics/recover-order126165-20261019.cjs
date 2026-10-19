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
  if (!['inspect', 'send', 'verify'].includes(phase)) throw Error('Unsupported recovery phase');
  const user = await db.user.findUnique({ where: { id: USER }, select: { isActive: true, deletedAt: true } });
  if (!user?.isActive || user.deletedAt) throw Error('Inactive owner');
  const order = await target(), saved = await originals(), live = await liveOrder(order);
  if (phase === 'verify') {
    const receipt = saved.receipts.find(r => r.clientRevision === 31);
    const rawOrder = await db.order.findUnique({ where: { guid: GUID }, select: { clientPayloadHash: true } });
    const { clientOrderPayloadHash } = require('/app/dist/modules/clientOrders/acceptedClientOperation');
    if (!receipt || receipt.state !== 'QUEUED' || receipt.orderGuid !== GUID || !receipt.payload
      || rawOrder.clientPayloadHash !== clientOrderPayloadHash(clientOrderMutationSchema.parse(receipt.payload))) throw Error('Accepted recovery packet not proven');
    const linesMatch = hash(businessLines(order)) === hash(businessLines(live));
    log({ stage: 'recovery-result', order: summary(order), live: { guid: live.guid, appGuid: live.appGuid,
      number1c: live.number1c, rows: live.items.length, amount: Number(live.totalAmount), posted: live.isPostedIn1c,
      status: live.status }, exactLinesMatch: linesMatch,
      receipt: { id: receipt.id, state: receipt.state, clientRevision: receipt.clientRevision, payloadHash: receipt.payloadHash,
        errorCode: receipt.errorCode, errorMessage: receipt.errorMessage },
      backup: saved.backup && { clientRevision: saved.backup.clientRevision, submittedOrderGuid: saved.backup.submittedOrderGuid, review: saved.backup.review },
      lines: live.items.map(i => ({ lineGuid: i.lineGuid, productGuid: i.product?.guid, name: i.product?.name,
        quantity: i.quantity, price: i.price, amount: i.lineAmount })) });
    if (order.clientRevision !== 31 || order.status !== 'CONFIRMED' || order.syncState !== 'SYNCED'
      || !order.isPostedIn1c || order.items.length !== 19 || Number(order.totalAmount) !== 43028
      || !live.isPostedIn1c || live.items.length !== 19 || Number(live.totalAmount) !== 43028 || !linesMatch
      || order.lastExportError || order.last1cError || order.draftReview || receipt.errorCode || receipt.errorMessage
      || saved.backup?.review || saved.backup?.submittedOrderGuid !== GUID) throw Error('Recovery not fully posted/reconciled or current error remains');
    log({ stage: 'verified', postedInSameOnecDocument: true, duplicateCreated: false, all19LinesMatch: true,
      currentApiErrors: false, oldRejectedReceiptPreservedAsHistory: true });
    return;
  }
  const source = saved.source;
  const nextRevision = Math.max(source.revision, order.clientRevision || 0) + 1;
  const body = clientOrderMutationSchema.parse({ ...source.payload, clientRevision: nextRevision, intent: 'SUBMIT', offlineReview: { pricePolicy: 'ASK' } });
  const review = await service.previewClientOrderAmendment(USER, CLIENT, body);
  const apiLines = businessLines(order), liveLines = businessLines(live);
  if (phase === 'send') {
    if (process.env.SOURCE_REVISION !== '30' || source.revision !== 30
      || process.env.SOURCE_HASH !== '2efa66f3deca569c740447cbe8afaf8c4aea0cbe068f021f43ab5933c46d033b'
      || inbox.submissionPayloadHash(source.payload) !== process.env.SOURCE_HASH
      || order.clientRevision !== 29 || order.revision !== 3 || order.items.length !== 16
      || Number(order.totalAmount) !== 36548 || order.hasRealization || live.hasRealization
      || order.syncState !== 'SYNCED' || !order.isPostedIn1c || !live.isPostedIn1c
      || hash(apiLines) !== hash(liveLines) || body.items.length !== 19 || nextRevision !== 31
      || review.baseContentToken !== 'a92338a4ceae45d97c63159e24dc37e0bd5b9548218bad07f91b9b00b1bba63b'
      || review.changes.some(c => !['Добавление строки', 'Изменение реквизита'].includes(c.reason))
      || review.changes.filter(c => c.reason === 'Добавление строки').length !== 3
      || review.confirmationToken) throw Error('Latest proposal or baseline drift; do not send blindly');
    const packet = { ...body, integrity: { baseContentToken: review.baseContentToken } };
    const packetHash = inbox.submissionPayloadHash(packet);
    const userWithRole = await db.user.findUnique({ where: { id: USER }, include: { role: true } });
    if (!userWithRole.role?.name || !process.env.ACCESS_TOKEN_SECRET) throw Error('Owner authorization unavailable');
    const jwt = require('jsonwebtoken').sign({ userId: USER, role: userWithRole.role.name,
      permissions: [], profileStatus: userWithRole.profileStatus }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '2m' });
    const response = await fetch('http://127.0.0.1:3000/api/client-orders/submissions/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
      body: JSON.stringify({ items: [{ clientOrderId: CLIENT, payloadHash: packetHash, payload: packet }] }),
      signal: AbortSignal.timeout(30000) });
    const answer = await response.json();
    const receipt = answer.data?.results?.[0];
    if (response.status !== 202 || receipt?.accepted !== true || receipt.clientRevision !== 31
      || receipt.payloadHash !== packetHash || receipt.clientOrderId !== CLIENT || receipt.userId !== USER) {
      log({ stage: 'intake-error', status: response.status, error: answer.error, result: receipt });
      throw Error('Recovery intake not accepted');
    }
    log({ stage: 'recovery-accepted', status: response.status, receiptId: receipt.submissionId,
      clientRevision: receipt.clientRevision, payloadHash: receipt.payloadHash, state: receipt.state,
      rows: packet.items.length, expectedAmount: 43028, originalReceiptUnmodified: true, authorizedByUser: true });
    for (let attempt = 0; attempt < 90; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const result = await db.clientOrderSubmission.findUnique({ where: { id: receipt.submissionId } });
      if (['NEEDS_REVIEW', 'REJECTED'].includes(result.state)) {
        log({ stage: 'recovery-business-rejection', state: result.state, code: result.errorCode,
          message: result.errorMessage, details: result.errorDetails });
        throw Error('Normal commercial validation rejected recovery; no force or error clearing');
      }
      if (result.state === 'QUEUED') {
        const current = await target();
        if (current.status === 'CONFIRMED' && current.syncState === 'SYNCED' && current.clientRevision === 31) {
          log({ stage: 'recovery-materialized', order: summary(current), receiptId: result.id });
          return;
        }
        if (current.lastExportError || current.last1cError) log({ stage: 'export-status',
          status: current.status, syncState: current.syncState, error: current.lastExportError || current.last1cError });
      }
    }
    throw Error('Recovery remains durably queued; verify before any retry');
  }
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
