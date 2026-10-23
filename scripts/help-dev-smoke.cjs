/* Explicit dev-only smoke. Retains clearly marked QA data; never alters existing users. */
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.HELP_SMOKE_TARGET !== 'dev') {
    throw new Error('NODE_ENV=development and HELP_SMOKE_TARGET=dev are required');
  }
  const database = new URL(process.env.DATABASE_URL || 'http://invalid').pathname.slice(1);
  if (!database || process.env.HELP_SMOKE_DATABASE_CONFIRM !== decodeURIComponent(database)) {
    throw new Error('HELP_SMOKE_DATABASE_CONFIRM must match the approved dev database');
  }
  if (!process.env.ACCESS_TOKEN_SECRET) throw new Error('Existing dev ACCESS_TOKEN_SECRET is required');
  const { default: prisma, pool } = require('../dist/prisma/client');
  const marker = `help_smoke_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const checks = [];
  const clients = [];
  const baseUrl = 'http://127.0.0.1:3000';
  let owner, specialist, stranger;
  let ticketId;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const identity = () => crypto.randomUUID();
  const headers = actor => ({ Authorization: `Bearer ${actor.token}` });
  const request = async (actor, endpoint, method = 'GET', body, expected = 200) => {
    const response = await fetch(baseUrl + endpoint, {
      method,
      headers: { ...headers(actor), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({}));
    assert(response.status === expected, `${method} ${endpoint}: HTTP ${response.status}, ${data.code || 'unexpected response'}`);
    return data;
  };
  try {
    const role = await prisma.role.create({ data: { name: `${marker}_employee`, displayName: 'DEV QA Помощь' } });
    const itRole = await prisma.role.create({ data: { name: `${marker}_it`, displayName: 'DEV QA IT Помощь' } });
    const permission = await prisma.permission.findUnique({ where: { name: 'manage_help' } });
    assert(permission, 'manage_help permission migration is missing');
    await prisma.rolePermissions.create({ data: { roleId: itRole.id, permissionId: permission.id } });
    const user = async (suffix, assignedRole) => {
      const row = await prisma.user.create({ data: {
        email: `${marker}_${suffix}@example.invalid`, firstName: 'DEV QA', lastName: suffix,
        roleId: assignedRole.id, isActive: true, profileStatus: 'ACTIVE', currentProfileType: 'EMPLOYEE',
        employeeProfile: { create: { status: 'ACTIVE' } },
      } });
      const token = jwt.sign({ userId: row.id, role: assignedRole.name, permissions: [], profileStatus: 'ACTIVE' }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '5m' });
      return { id: row.id, token };
    };
    owner = await user('owner', role);
    specialist = await user('it', itRole);
    stranger = await user('stranger', role);
    const config = await request(owner, '/help/config');
    assert(config.aiEnabled === false, 'AI must remain disabled');
    checks.push('config_ai_disabled');

    const payload = { clientTicketId: identity(), clientMessageId: identity(), text: `[DEV QA ${marker}] Проверка сервиса помощи` };
    const created = await request(owner, '/help/tickets', 'POST', payload);
    ticketId = created.ticket.id;
    const repeated = await request(owner, '/help/tickets', 'POST', payload);
    assert(repeated.ticket.id === ticketId && repeated.messages.length === 1, 'Creation retry duplicated data');
    await request(owner, '/help/tickets', 'POST', { ...payload, text: 'Conflicting payload' }, 409);
    checks.push('persistent_idempotent_create');
    await request(stranger, `/help/tickets/${ticketId}`, 'GET', undefined, 404);
    checks.push('foreign_ticket_acl');
    await request(specialist, `/help/tickets/${ticketId}/claim`, 'POST', {});
    await request(specialist, `/help/tickets/${ticketId}/messages`, 'POST', { clientMessageId: identity(), text: 'DEV QA IT: проверено', replyToId: created.messages[0].id });
    checks.push('it_claim_reply');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('files', new Blob([png], { type: 'image/png' }), 'dev-qa.png');
    form.append('files', new Blob(['DEV QA attachment'], { type: 'text/plain' }), 'dev-qa.txt');
    const upload = await request(owner, '/help/attachments', 'POST', form, 201);
    assert(upload.attachments?.length === 2, 'Mixed upload failed');
    const file = upload.attachments[0];
    const download = await fetch(baseUrl + file.url, { headers: headers(owner), signal: AbortSignal.timeout(30000) });
    assert(download.status === 200 && Buffer.from(await download.arrayBuffer()).equals(png), 'Private image bytes differ');
    await request(stranger, file.url, 'GET', undefined, 404);
    const anonymous = await fetch(baseUrl + file.url, { signal: AbortSignal.timeout(10000) });
    assert(anonymous.status === 401, 'Anonymous download bypassed authorization');
    const { helpS3, helpBucket } = require('../dist/modules/help/help.storage');
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const object = await prisma.helpAttachment.findUniqueOrThrow({ where: { id: file.id } });
    assert(object.objectKey.startsWith('dev/help/'), 'Attachment escaped dev/help prefix');
    const genericUrl = '/files/' + object.objectKey.split('/').map(encodeURIComponent).join('/');
    const generic = await fetch(baseUrl + genericUrl, { signal: AbortSignal.timeout(10000) });
    assert(generic.status === 404, 'General files proxy exposed Help object');
    const { signFileToken } = require('../dist/utils/fileTokens');
    const genericWithToken = await fetch(baseUrl + genericUrl + '?token=' + encodeURIComponent(signFileToken(object.objectKey)), { signal: AbortSignal.timeout(10000) });
    assert(genericWithToken.status === 404, 'General file token bypassed ticket ACL');
    const signed = new URL(await getSignedUrl(helpS3, new GetObjectCommand({ Bucket: helpBucket, Key: object.objectKey }), { expiresIn: 30 }));
    signed.search = '';
    const direct = await fetch(signed, { signal: AbortSignal.timeout(20000) });
    assert([401, 403, 404].includes(direct.status), `S3 object is publicly readable: HTTP ${direct.status}`);
    await request(owner, `/help/tickets/${ticketId}/messages`, 'POST', { clientMessageId: identity(), text: 'DEV QA фото и файл', attachmentIds: upload.attachments.map(a => a.id) });
    checks.push('real_s3_mixed_upload_private_download');

    if (typeof WebSocket === 'function') {
      const connect = async actor => {
        const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
        clients.push(ws);
        const packets = [];
        ws.addEventListener('message', event => {
          const packet = String(event.data); packets.push(packet);
          if (packet.startsWith('0')) ws.send(`40${JSON.stringify({ token: actor.token })}`);
          if (packet === '2') ws.send('3');
        });
        const until = async predicate => {
          const start = Date.now();
          while (Date.now() - start < 10000) {
            const index = packets.findIndex(predicate);
            if (index >= 0) return packets.splice(index, 1)[0];
            await new Promise(resolve => setTimeout(resolve, 30));
          }
          throw new Error('WebSocket acknowledgement/event timeout');
        };
        await until(p => p.startsWith('40'));
        return { ws, packets, until };
      };
      const socket = await connect(owner);
      socket.ws.send(`421${JSON.stringify(['help:subscribe', { ticketId }])}`);
      assert(JSON.parse((await socket.until(p => p.startsWith('431['))).slice(3))[0].ok, 'Authorized socket denied');
      const outsider = await connect(stranger);
      outsider.ws.send(`421${JSON.stringify(['help:subscribe', { ticketId }])}`);
      assert(!JSON.parse((await outsider.until(p => p.startsWith('431['))).slice(3))[0].ok, 'Foreign socket subscribe bypassed ACL');
      outsider.ws.send(`42${JSON.stringify(['join', `help:${ticketId}`])}`);
      await request(specialist, `/help/tickets/${ticketId}/messages`, 'POST', { clientMessageId: identity(), text: 'DEV QA websocket event' });
      const event = JSON.parse((await socket.until(p => p.startsWith('42[') && JSON.parse(p.slice(2))[0] === 'help:event')).slice(2))[1];
      assert(event.ticketId === ticketId, 'Socket event ticket mismatch');
      await new Promise(resolve => setTimeout(resolve, 250));
      assert(!outsider.packets.some(p => p.includes('help:event')), 'Foreign socket received metadata');
      checks.push('websocket_delivery_acl');
    } else throw new Error('Node WebSocket unavailable; socket smoke not verified');

    const closed = await request(owner, `/help/tickets/${ticketId}/close`, 'POST', { clientMessageId: identity(), text: '', rating: 0 });
    assert(closed.ticket.status === 'CLOSED' && closed.messages.slice(-1)[0].rating === 0, 'Closure/rating0 persistence failed');
    const reopened = await request(owner, `/help/tickets/${ticketId}/reopen`, 'POST', { clientMessageId: identity(), text: 'DEV QA повторное открытие' });
    assert(reopened.ticket.status === 'OPEN' && reopened.ticket.aiEnabled === false, 'Reopen enabled AI or failed');
    // Leave QA ticket closed to keep the live IT queue clean; preserve all QA evidence.
    await request(owner, `/help/tickets/${ticketId}/close`, 'POST', { clientMessageId: identity(), text: 'DEV QA завершена', rating: 0 });
    checks.push('close_zero_stars_reopen_close');
    const notifications = await prisma.helpNotification.count({ where: { ticketId } });
    assert(notifications > 0, 'Notification outbox is empty');
    checks.push('notification_outbox_persisted');
    console.log(JSON.stringify({ ok: true, marker, ticketId, qaUserIds: [owner.id, specialist.id, stranger.id], checks, pushDeviceDelivery: 'NOT_RUN', retained: true }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, marker, ticketId, checks, error: error.message, retained: true }));
    process.exitCode = 1;
  } finally {
    for (const client of clients) client.close();
    await prisma.$disconnect();
    await pool.end();
  }
}
main().catch(error => { console.error('[help dev smoke]', error.message); process.exitCode = 1; });
