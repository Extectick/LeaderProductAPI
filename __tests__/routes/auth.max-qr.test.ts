import crypto from 'crypto';
import request from 'supertest';

process.env.MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN || 'test-max-bot-token';
process.env.MAX_BOT_USERNAME = process.env.MAX_BOT_USERNAME || 'leaderproduct_test_max_bot';
process.env.MAX_WEBHOOK_SECRET = 'test-max-webhook-secret-qr';

jest.mock('../../src/services/maxBotService', () => {
  const actual = jest.requireActual('../../src/services/maxBotService');
  return {
    ...actual,
    sendMaxPhoneContactRequestMessage: jest.fn().mockResolvedValue(true),
    sendMaxInfoMessage: jest.fn().mockResolvedValue(true),
  };
});

import app, { prisma } from '../../src';

function uniq(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sha256(raw: string) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function extractStartToken(deepLinkUrl: string) {
  const match = String(deepLinkUrl).match(/[?&]start=auth_qr_([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error(`Unable to extract start token from deepLinkUrl: ${deepLinkUrl}`);
  return match[1];
}

function buildMaxStartUpdate(maxUserId: number, startToken: string, username: string) {
  return {
    update_type: 'bot_started',
    timestamp: Date.now(),
    payload: `auth_qr_${startToken}`,
    user: {
      user_id: maxUserId,
      name: 'QR MAX',
      username,
      is_bot: false,
      last_activity_time: Date.now(),
    },
    chat_id: maxUserId,
  };
}

function buildMaxContactUpdate(maxUserId: number, username: string, phone: string) {
  return {
    update_type: 'message_created',
    timestamp: Date.now(),
    message: {
      sender: {
        user_id: maxUserId,
        name: 'QR MAX',
        username,
        is_bot: false,
        last_activity_time: Date.now(),
      },
      recipient: { chat_id: maxUserId, chat_type: 'dialog' },
      timestamp: Date.now(),
      body: {
        mid: uniq('max_qr_mid'),
        seq: 1,
        text: null,
        attachments: [
          {
            type: 'contact',
            payload: {
              vcf_info: `BEGIN:VCARD\nVERSION:3.0\nFN:QR MAX\nTEL:${phone}\nEND:VCARD`,
            },
          },
        ],
      },
    },
  };
}

describe('Auth: MAX QR desktop flow', () => {
  let userRoleId: number;
  const createdUserIds = new Set<number>();
  const startedSessionTokens = new Set<string>();
  const messengerUserIds = new Set<string>();
  const webhookSecret = process.env.MAX_WEBHOOK_SECRET as string;

  const trackUser = (userId: number) => {
    createdUserIds.add(userId);
    return userId;
  };

  const trackSessionToken = (sessionToken: string) => {
    const token = String(sessionToken || '').trim();
    if (token) startedSessionTokens.add(token);
    return token;
  };

  const trackMessengerId = (messengerId: string | number | bigint) => {
    const id = String(messengerId);
    messengerUserIds.add(id);
    return id;
  };

  const cleanupSessions = async () => {
    const sessionTokenHashes = Array.from(startedSessionTokens).map(sha256);
    if (sessionTokenHashes.length) {
      await prisma.messengerQrAuthSession.deleteMany({
        where: {
          provider: 'MAX',
          clientTokenHash: { in: sessionTokenHashes },
        },
      });
    }

    const ids = Array.from(messengerUserIds).map((id) => BigInt(id));
    if (ids.length) {
      await prisma.messengerQrAuthSession.deleteMany({
        where: {
          provider: 'MAX',
          messengerUserId: { in: ids },
        },
      });
    }
    startedSessionTokens.clear();
    messengerUserIds.clear();
  };

  const cleanupUsers = async () => {
    const ids = Array.from(createdUserIds);
    if (!ids.length) return;

    await prisma.messengerQrAuthSession.updateMany({
      where: { resolvedUserId: { in: ids } },
      data: { resolvedUserId: null },
    });
    await prisma.messengerQrAuthSession.deleteMany({
      where: { resolvedUserId: { in: ids } },
    });
    await prisma.phoneVerificationSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.emailChangeSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.deviceToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.appealMessageRead.deleteMany({ where: { userId: { in: ids } } });
    await prisma.appealMessage.deleteMany({ where: { senderId: { in: ids } } });
    await prisma.appealWatcher.deleteMany({ where: { userId: { in: ids } } });
    await prisma.appealAssignee.deleteMany({ where: { userId: { in: ids } } });
    await prisma.appealStatusHistory.deleteMany({ where: { changedById: { in: ids } } });
    await prisma.appeal.deleteMany({ where: { createdById: { in: ids } } });
    await prisma.routePoint.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userRoute.deleteMany({ where: { userId: { in: ids } } });
    await prisma.loginAttempt.deleteMany({ where: { userId: { in: ids } } });
    await prisma.passwordReset.deleteMany({ where: { userId: { in: ids } } });
    await prisma.emailVerification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.departmentRole.deleteMany({ where: { userId: { in: ids } } });
    await prisma.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.clientProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.supplierProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userNotificationSettings.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });

    createdUserIds.clear();
  };

  beforeAll(async () => {
    const userRole = await prisma.role.upsert({
      where: { name: 'user' },
      update: { displayName: 'Пользователь' },
      create: { name: 'user', displayName: 'Пользователь' },
    });
    userRoleId = userRole.id;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupSessions();
    await cleanupUsers();
  });

  it('happy path: start -> bot_started -> contact -> status AUTHORIZED with tokens/profile', async () => {
    const maxUserId = Number(`93${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);
    const username = uniq('max_qr_happy');
    const phone = '+7 999 000 5566';
    const user = await prisma.user.create({
      data: {
        roleId: userRoleId,
        email: `${uniq('max_qr_owner')}@example.com`,
        firstName: 'QR',
        lastName: 'MAX',
        phone: BigInt('79990005566'),
        isActive: true,
        profileStatus: 'ACTIVE',
        authProvider: 'LOCAL',
      },
      select: { id: true },
    });
    trackUser(user.id);
    trackMessengerId(maxUserId);

    const startRes = await request(app).post('/auth/max/qr/start').send({});
    expect(startRes.status).toBe(200);
    expect(startRes.body?.ok).toBe(true);
    const started = startRes.body?.data;
    const sessionToken = trackSessionToken(started?.sessionToken);
    expect(sessionToken).toBeTruthy();
    expect(started?.provider).toBe('MAX');
    expect(String(started?.deepLinkUrl || '')).toContain('https://max.ru/');

    const startToken = extractStartToken(String(started?.deepLinkUrl || ''));

    const startWebhookRes = await request(app)
      .post('/auth/max/webhook')
      .set('X-Max-Bot-Api-Secret', webhookSecret)
      .send(buildMaxStartUpdate(maxUserId, startToken, username));
    expect(startWebhookRes.status).toBe(200);
    expect(startWebhookRes.body?.ok).toBe(true);

    const contactWebhookRes = await request(app)
      .post('/auth/max/webhook')
      .set('X-Max-Bot-Api-Secret', webhookSecret)
      .send(buildMaxContactUpdate(maxUserId, username, phone));
    expect(contactWebhookRes.status).toBe(200);
    expect(contactWebhookRes.body?.ok).toBe(true);

    const statusRes = await request(app)
      .get('/auth/max/qr/status')
      .query({ sessionToken });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body?.ok).toBe(true);
    expect(statusRes.body?.data?.state).toBe('AUTHORIZED');
    expect(statusRes.body?.data?.accessToken).toBeTruthy();
    expect(statusRes.body?.data?.refreshToken).toBeTruthy();
    expect(statusRes.body?.data?.profile).toBeTruthy();

    const linked = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        maxId: true,
        maxUsername: true,
        maxLinkedAt: true,
        authProvider: true,
      },
    });
    expect(linked?.maxId?.toString()).toBe(String(maxUserId));
    expect(linked?.maxUsername).toBe(username);
    expect(linked?.maxLinkedAt).toBeTruthy();
    expect(linked?.authProvider).toBe('HYBRID');
  });

  it('conflict: phone owner already linked to another max id -> FAILED ACCOUNT_CONFLICT', async () => {
    const existingMaxId = BigInt('800000001111');
    const conflictPhone = '+7 999 000 6677';
    const owner = await prisma.user.create({
      data: {
        roleId: userRoleId,
        email: `${uniq('max_qr_conflict_owner')}@example.com`,
        firstName: 'Conflict',
        lastName: 'Owner',
        phone: BigInt('79990006677'),
        maxId: existingMaxId,
        maxUsername: 'already_linked_max',
        maxLinkedAt: new Date(),
        isActive: true,
        profileStatus: 'ACTIVE',
        authProvider: 'HYBRID',
      },
      select: { id: true },
    });
    trackUser(owner.id);

    const incomingMaxId = Number(`94${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);
    trackMessengerId(incomingMaxId);

    const startRes = await request(app).post('/auth/max/qr/start').send({});
    expect(startRes.status).toBe(200);
    const sessionToken = trackSessionToken(startRes.body?.data?.sessionToken);
    const startToken = extractStartToken(String(startRes.body?.data?.deepLinkUrl || ''));

    await request(app)
      .post('/auth/max/webhook')
      .set('X-Max-Bot-Api-Secret', webhookSecret)
      .send(buildMaxStartUpdate(incomingMaxId, startToken, uniq('max_qr_conflict')));

    await request(app)
      .post('/auth/max/webhook')
      .set('X-Max-Bot-Api-Secret', webhookSecret)
      .send(buildMaxContactUpdate(incomingMaxId, uniq('max_qr_conflict_contact'), conflictPhone));

    const statusRes = await request(app)
      .get('/auth/max/qr/status')
      .query({ sessionToken });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body?.ok).toBe(true);
    expect(statusRes.body?.data?.state).toBe('FAILED');
    expect(statusRes.body?.data?.failureReason).toBe('ACCOUNT_CONFLICT');

    const unchanged = await prisma.user.findUnique({
      where: { id: owner.id },
      select: { maxId: true },
    });
    expect(unchanged?.maxId?.toString()).toBe(existingMaxId.toString());
  });

  it('cancel: start -> cancel -> status CANCELLED', async () => {
    const startRes = await request(app).post('/auth/max/qr/start').send({});
    expect(startRes.status).toBe(200);
    const sessionToken = trackSessionToken(startRes.body?.data?.sessionToken);

    const cancelRes = await request(app)
      .post('/auth/max/qr/cancel')
      .send({ sessionToken });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body?.ok).toBe(true);
    expect(cancelRes.body?.data?.cancelled).toBe(true);

    const statusRes = await request(app)
      .get('/auth/max/qr/status')
      .query({ sessionToken });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body?.ok).toBe(true);
    expect(statusRes.body?.data?.state).toBe('CANCELLED');
  });

  it('expiry: force expiresAt in DB -> status EXPIRED', async () => {
    const startRes = await request(app).post('/auth/max/qr/start').send({});
    expect(startRes.status).toBe(200);
    const sessionToken = trackSessionToken(startRes.body?.data?.sessionToken);

    await prisma.messengerQrAuthSession.updateMany({
      where: {
        provider: 'MAX',
        clientTokenHash: sha256(sessionToken),
      },
      data: {
        expiresAt: new Date(Date.now() - 5_000),
      },
    });

    const statusRes = await request(app)
      .get('/auth/max/qr/status')
      .query({ sessionToken });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body?.ok).toBe(true);
    expect(statusRes.body?.data?.state).toBe('EXPIRED');
  });
});

