import crypto from 'crypto';
import request from 'supertest';

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-telegram-bot-token';
process.env.TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'leaderproduct_test_bot';
process.env.TELEGRAM_WEBHOOK_SECRET = '';

jest.mock('../../src/services/telegramBotService', () => {
  const actual = jest.requireActual('../../src/services/telegramBotService');
  return {
    ...actual,
    sendPhoneContactRequestMessage: jest.fn().mockResolvedValue(true),
    sendTelegramInfoMessage: jest.fn().mockResolvedValue(true),
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

function buildTelegramStartUpdate(telegramId: number, startToken: string, username: string) {
  return {
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      from: {
        id: telegramId,
        is_bot: false,
        first_name: 'QR',
        username,
      },
      chat: {
        id: telegramId,
        type: 'private',
      },
      text: `/start auth_qr_${startToken}`,
    },
  };
}

function buildTelegramContactUpdate(telegramId: number, username: string, phone: string) {
  return {
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      from: {
        id: telegramId,
        is_bot: false,
        first_name: 'QR',
        username,
      },
      chat: {
        id: telegramId,
        type: 'private',
      },
      contact: {
        phone_number: phone,
        user_id: telegramId,
        first_name: 'QR',
      },
    },
  };
}

describe('Auth: Telegram QR desktop flow', () => {
  let userRoleId: number;
  const createdUserIds = new Set<number>();
  const startedSessionTokens = new Set<string>();
  const messengerUserIds = new Set<string>();

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
          provider: 'TELEGRAM',
          clientTokenHash: { in: sessionTokenHashes },
        },
      });
    }

    const ids = Array.from(messengerUserIds).map((id) => BigInt(id));
    if (ids.length) {
      await prisma.messengerQrAuthSession.deleteMany({
        where: {
          provider: 'TELEGRAM',
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

  it('happy path: start -> /start -> contact -> status AUTHORIZED with tokens/profile', async () => {
    const telegramId = Number(`91${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);
    const username = uniq('tg_qr_happy');
    const phone = '+7 999 000 3344';
    const user = await prisma.user.create({
      data: {
        roleId: userRoleId,
        email: `${uniq('tg_qr_owner')}@example.com`,
        firstName: 'QR',
        lastName: 'Telegram',
        phone: BigInt('79990003344'),
        isActive: true,
        profileStatus: 'ACTIVE',
        authProvider: 'LOCAL',
      },
      select: { id: true },
    });
    trackUser(user.id);
    trackMessengerId(telegramId);

    const startRes = await request(app).post('/auth/telegram/qr/start').send({});
    expect(startRes.status).toBe(200);
    expect(startRes.body?.ok).toBe(true);
    const started = startRes.body?.data;
    const sessionToken = trackSessionToken(started?.sessionToken);
    expect(sessionToken).toBeTruthy();
    expect(started?.provider).toBe('TELEGRAM');
    expect(String(started?.deepLinkUrl || '')).toContain('https://t.me/');

    const startToken = extractStartToken(String(started?.deepLinkUrl || ''));

    const startWebhookRes = await request(app)
      .post('/auth/telegram/webhook')
      .send(buildTelegramStartUpdate(telegramId, startToken, username));
    expect(startWebhookRes.status).toBe(200);
    expect(startWebhookRes.body?.ok).toBe(true);

    const contactWebhookRes = await request(app)
      .post('/auth/telegram/webhook')
      .send(buildTelegramContactUpdate(telegramId, username, phone));
    expect(contactWebhookRes.status).toBe(200);
    expect(contactWebhookRes.body?.ok).toBe(true);

    const statusRes = await request(app)
      .get('/auth/telegram/qr/status')
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
        telegramId: true,
        telegramUsername: true,
        telegramLinkedAt: true,
        authProvider: true,
      },
    });
    expect(linked?.telegramId?.toString()).toBe(String(telegramId));
    expect(linked?.telegramUsername).toBe(username);
    expect(linked?.telegramLinkedAt).toBeTruthy();
    expect(linked?.authProvider).toBe('HYBRID');
  });

  it('conflict: phone owner already linked to another telegram id -> FAILED ACCOUNT_CONFLICT', async () => {
    const existingTelegramId = BigInt('700000001111');
    const conflictPhone = '+7 999 000 4455';
    const owner = await prisma.user.create({
      data: {
        roleId: userRoleId,
        email: `${uniq('tg_qr_conflict_owner')}@example.com`,
        firstName: 'Conflict',
        lastName: 'Owner',
        phone: BigInt('79990004455'),
        telegramId: existingTelegramId,
        telegramUsername: 'already_linked_tg',
        telegramLinkedAt: new Date(),
        isActive: true,
        profileStatus: 'ACTIVE',
        authProvider: 'HYBRID',
      },
      select: { id: true },
    });
    trackUser(owner.id);

    const incomingTelegramId = Number(`92${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);
    trackMessengerId(incomingTelegramId);

    const startRes = await request(app).post('/auth/telegram/qr/start').send({});
    expect(startRes.status).toBe(200);
    const sessionToken = trackSessionToken(startRes.body?.data?.sessionToken);
    const startToken = extractStartToken(String(startRes.body?.data?.deepLinkUrl || ''));

    await request(app)
      .post('/auth/telegram/webhook')
      .send(buildTelegramStartUpdate(incomingTelegramId, startToken, uniq('tg_qr_conflict')));

    await request(app)
      .post('/auth/telegram/webhook')
      .send(buildTelegramContactUpdate(incomingTelegramId, uniq('tg_qr_conflict_contact'), conflictPhone));

    const statusRes = await request(app)
      .get('/auth/telegram/qr/status')
      .query({ sessionToken });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body?.ok).toBe(true);
    expect(statusRes.body?.data?.state).toBe('FAILED');
    expect(statusRes.body?.data?.failureReason).toBe('ACCOUNT_CONFLICT');

    const unchanged = await prisma.user.findUnique({
      where: { id: owner.id },
      select: { telegramId: true },
    });
    expect(unchanged?.telegramId?.toString()).toBe(existingTelegramId.toString());
  });

  it('cancel: start -> cancel -> status CANCELLED', async () => {
    const startRes = await request(app).post('/auth/telegram/qr/start').send({});
    expect(startRes.status).toBe(200);
    const sessionToken = trackSessionToken(startRes.body?.data?.sessionToken);

    const cancelRes = await request(app)
      .post('/auth/telegram/qr/cancel')
      .send({ sessionToken });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body?.ok).toBe(true);
    expect(cancelRes.body?.data?.cancelled).toBe(true);

    const statusRes = await request(app)
      .get('/auth/telegram/qr/status')
      .query({ sessionToken });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body?.ok).toBe(true);
    expect(statusRes.body?.data?.state).toBe('CANCELLED');
  });

  it('expiry: force expiresAt in DB -> status EXPIRED', async () => {
    const startRes = await request(app).post('/auth/telegram/qr/start').send({});
    expect(startRes.status).toBe(200);
    const sessionToken = trackSessionToken(startRes.body?.data?.sessionToken);

    await prisma.messengerQrAuthSession.updateMany({
      where: {
        provider: 'TELEGRAM',
        clientTokenHash: sha256(sessionToken),
      },
      data: {
        expiresAt: new Date(Date.now() - 5_000),
      },
    });

    const statusRes = await request(app)
      .get('/auth/telegram/qr/status')
      .query({ sessionToken });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body?.ok).toBe(true);
    expect(statusRes.body?.data?.state).toBe('EXPIRED');
  });
});

