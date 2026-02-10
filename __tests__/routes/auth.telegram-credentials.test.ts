import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import app, { prisma } from '../../src';

function uniq(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function issueTelegramSessionToken(telegramId: string, username: string | null = null) {
  const secret =
    process.env.TG_SESSION_SECRET ||
    process.env.ACCESS_TOKEN_SECRET ||
    'tg-session-secret';
  return jwt.sign(
    {
      telegramId,
      username,
      firstName: 'Test',
      lastName: 'User',
    },
    secret,
    { algorithm: 'HS256', expiresIn: '10m' }
  );
}

describe('Auth: Telegram + credentials flow', () => {
  let userRoleId: number;
  const createdUserIds = new Set<number>();

  const trackUser = (userId: number) => {
    createdUserIds.add(userId);
    return userId;
  };

  const cleanupUsers = async () => {
    const ids = Array.from(createdUserIds);
    if (!ids.length) return;

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
    await prisma.user.deleteMany({ where: { id: { in: ids } } });

    createdUserIds.clear();
  };

  beforeAll(async () => {
    const userRole = await prisma.role.upsert({
      where: { name: 'user' },
      update: {},
      create: { name: 'user' },
    });
    userRoleId = userRole.id;
  });

  afterEach(async () => {
    await cleanupUsers();
  });

  it('Telegram -> credentials -> verify -> password login works and profile exposes authMethods', async () => {
    const telegramId = `${9000000000 + Math.floor(Math.random() * 1000000)}`;
    const telegramUser = await prisma.user.create({
      data: {
        roleId: userRoleId,
        firstName: 'Telegram',
        lastName: 'Flow',
        phone: BigInt('79990001122'),
        telegramId: BigInt(telegramId),
        telegramUsername: 'tg_flow_user',
        telegramLinkedAt: new Date(),
        authProvider: 'TELEGRAM',
        isActive: true,
        profileStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    trackUser(telegramUser.id);

    const tgSessionToken = issueTelegramSessionToken(telegramId, 'tg_flow_user');
    const signInRes = await request(app)
      .post('/auth/telegram/sign-in')
      .send({ tgSessionToken });

    expect(signInRes.status).toBe(200);
    expect(signInRes.body?.ok).toBe(true);
    const accessToken = signInRes.body?.data?.accessToken as string;
    expect(accessToken).toBeTruthy();

    const profileBefore = await request(app)
      .get('/users/profile')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(profileBefore.status).toBe(200);
    expect(profileBefore.body?.data?.profile?.authMethods).toMatchObject({
      telegramLinked: true,
      passwordLoginEnabled: false,
      passwordLoginPendingVerification: false,
    });

    const email = `${uniq('tg_flow')}@example.com`;
    const password = 'Pa$$word123';

    const credentialsRes = await request(app)
      .post('/auth/credentials')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email, password });
    expect(credentialsRes.status).toBe(200);
    expect(credentialsRes.body?.ok).toBe(true);

    const userAfterCredentials = await prisma.user.findUnique({
      where: { id: telegramUser.id },
      select: { email: true, passwordHash: true, isActive: true, authProvider: true },
    });
    expect(userAfterCredentials?.email).toBe(email);
    expect(userAfterCredentials?.passwordHash).toBeTruthy();
    expect(userAfterCredentials?.isActive).toBe(false);
    expect(userAfterCredentials?.authProvider).toBe('HYBRID');

    const profilePending = await request(app)
      .get('/users/profile')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(profilePending.status).toBe(200);
    expect(profilePending.body?.data?.profile?.authMethods).toMatchObject({
      telegramLinked: true,
      passwordLoginEnabled: false,
      passwordLoginPendingVerification: true,
    });

    const latestVerification = await prisma.emailVerification.findFirst({
      where: { userId: telegramUser.id, used: false },
      orderBy: { createdAt: 'desc' },
      select: { code: true },
    });
    expect(latestVerification?.code).toBeTruthy();

    const verifyRes = await request(app)
      .post('/auth/verify')
      .send({ email, code: latestVerification?.code });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body?.ok).toBe(true);
    const verifiedAccessToken = verifyRes.body?.data?.accessToken as string;
    expect(verifiedAccessToken).toBeTruthy();

    const profileReady = await request(app)
      .get('/users/profile')
      .set('Authorization', `Bearer ${verifiedAccessToken}`);
    expect(profileReady.status).toBe(200);
    expect(profileReady.body?.data?.profile?.authMethods).toMatchObject({
      telegramLinked: true,
      passwordLoginEnabled: true,
      passwordLoginPendingVerification: false,
    });

    const passwordLoginRes = await request(app)
      .post('/auth/login')
      .send({ email, password });
    expect(passwordLoginRes.status).toBe(200);
    expect(passwordLoginRes.body?.ok).toBe(true);
    expect(passwordLoginRes.body?.data?.accessToken).toBeTruthy();
  });

  it('returns 409 on /auth/credentials when email belongs to another user', async () => {
    const occupiedEmail = `${uniq('occupied')}@example.com`;
    const occupiedPasswordHash = await bcrypt.hash('SomePass123!', 10);
    const localUser = await prisma.user.create({
      data: {
        email: occupiedEmail,
        passwordHash: occupiedPasswordHash,
        roleId: userRoleId,
        isActive: true,
        authProvider: 'LOCAL',
        profileStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    trackUser(localUser.id);

    const telegramId = `${9100000000 + Math.floor(Math.random() * 1000000)}`;
    const telegramUser = await prisma.user.create({
      data: {
        roleId: userRoleId,
        phone: BigInt('79990002233'),
        telegramId: BigInt(telegramId),
        telegramUsername: 'tg_conflict_user',
        telegramLinkedAt: new Date(),
        authProvider: 'TELEGRAM',
        isActive: true,
        profileStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    trackUser(telegramUser.id);

    const signInRes = await request(app)
      .post('/auth/telegram/sign-in')
      .send({ tgSessionToken: issueTelegramSessionToken(telegramId, 'tg_conflict_user') });
    expect(signInRes.status).toBe(200);
    const accessToken = signInRes.body?.data?.accessToken as string;

    const credentialsRes = await request(app)
      .post('/auth/credentials')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: occupiedEmail, password: 'AnotherPass123!' });

    expect(credentialsRes.status).toBe(409);
    expect(credentialsRes.body?.ok).toBe(false);
    expect(String(credentialsRes.body?.message || '')).toMatch(/email/i);
  });

  it('keeps NEED_LINK flow when Telegram phone matches existing account (no auto-link)', async () => {
    const existingPhone = '+79990003344';
    const existingEmail = `${uniq('phone_owner')}@example.com`;
    const existingUser = await prisma.user.create({
      data: {
        email: existingEmail,
        passwordHash: await bcrypt.hash('OwnerPass123!', 10),
        roleId: userRoleId,
        isActive: true,
        authProvider: 'LOCAL',
        profileStatus: 'ACTIVE',
        phone: BigInt('79990003344'),
      },
      select: { id: true },
    });
    trackUser(existingUser.id);

    const notLinkedTelegramId = `${9200000000 + Math.floor(Math.random() * 1000000)}`;
    const contactRes = await request(app)
      .post('/auth/telegram/contact')
      .send({
        tgSessionToken: issueTelegramSessionToken(notLinkedTelegramId, 'tg_need_link_user'),
        phoneE164: existingPhone,
      });

    expect(contactRes.status).toBe(200);
    expect(contactRes.body?.ok).toBe(true);
    expect(contactRes.body?.data?.state).toBe('NEED_LINK');
    expect(contactRes.body?.data?.conflictUserHint).toBeTruthy();

    const telegramOwner = await prisma.user.findFirst({
      where: { telegramId: BigInt(notLinkedTelegramId) },
      select: { id: true },
    });
    expect(telegramOwner).toBeNull();
  });
});
