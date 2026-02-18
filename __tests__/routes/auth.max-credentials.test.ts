import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import app, { prisma } from '../../src';

function uniq(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function issueMaxSessionToken(maxId: string, username: string | null = null) {
  const secret =
    process.env.MAX_SESSION_SECRET ||
    process.env.ACCESS_TOKEN_SECRET ||
    'max-session-secret';
  return jwt.sign(
    {
      maxId,
      username,
      firstName: 'Test',
      lastName: 'User',
    },
    secret,
    { algorithm: 'HS256', expiresIn: '10m' }
  );
}

describe('Auth: MAX + credentials flow', () => {
  let userRoleId: number;
  const createdUserIds = new Set<number>();

  const trackUser = (userId: number) => {
    createdUserIds.add(userId);
    return userId;
  };

  const cleanupUsers = async () => {
    const ids = Array.from(createdUserIds);
    if (!ids.length) return;

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

  afterEach(async () => {
    await cleanupUsers();
  });

  it('MAX -> credentials -> verify -> password login works and profile exposes authMethods', async () => {
    const maxId = `${9300000000 + Math.floor(Math.random() * 1000000)}`;
    const maxUser = await prisma.user.create({
      data: {
        roleId: userRoleId,
        firstName: 'Max',
        lastName: 'Flow',
        phone: BigInt('79990004455'),
        maxId: BigInt(maxId),
        maxUsername: 'max_flow_user',
        maxLinkedAt: new Date(),
        authProvider: 'MAX',
        isActive: true,
        profileStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    trackUser(maxUser.id);

    const maxSessionToken = issueMaxSessionToken(maxId, 'max_flow_user');
    const signInRes = await request(app)
      .post('/auth/max/sign-in')
      .send({ maxSessionToken });

    expect(signInRes.status).toBe(200);
    expect(signInRes.body?.ok).toBe(true);
    const accessToken = signInRes.body?.data?.accessToken as string;
    expect(accessToken).toBeTruthy();

    const profileBefore = await request(app)
      .get('/users/profile')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(profileBefore.status).toBe(200);
    expect(profileBefore.body?.data?.profile?.authMethods).toMatchObject({
      maxLinked: true,
      passwordLoginEnabled: false,
      passwordLoginPendingVerification: false,
    });

    const email = `${uniq('max_flow')}@example.com`;
    const password = 'Pa$$word123';

    const credentialsRes = await request(app)
      .post('/auth/credentials')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email, password });
    expect(credentialsRes.status).toBe(200);
    expect(credentialsRes.body?.ok).toBe(true);

    const userAfterCredentials = await prisma.user.findUnique({
      where: { id: maxUser.id },
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
      maxLinked: true,
      passwordLoginEnabled: false,
      passwordLoginPendingVerification: true,
    });

    const latestVerification = await prisma.emailVerification.findFirst({
      where: { userId: maxUser.id, used: false },
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
      maxLinked: true,
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

    const maxId = `${9400000000 + Math.floor(Math.random() * 1000000)}`;
    const maxUser = await prisma.user.create({
      data: {
        roleId: userRoleId,
        phone: BigInt('79990005566'),
        maxId: BigInt(maxId),
        maxUsername: 'max_conflict_user',
        maxLinkedAt: new Date(),
        authProvider: 'MAX',
        isActive: true,
        profileStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    trackUser(maxUser.id);

    const signInRes = await request(app)
      .post('/auth/max/sign-in')
      .send({ maxSessionToken: issueMaxSessionToken(maxId, 'max_conflict_user') });
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

  it('auto-links MAX by matching phone and returns READY', async () => {
    const existingPhone = '+79990006677';
    const existingEmail = `${uniq('phone_owner')}@example.com`;
    const existingUser = await prisma.user.create({
      data: {
        email: existingEmail,
        passwordHash: await bcrypt.hash('OwnerPass123!', 10),
        roleId: userRoleId,
        isActive: true,
        authProvider: 'LOCAL',
        profileStatus: 'ACTIVE',
        phone: BigInt('79990006677'),
      },
      select: { id: true },
    });
    trackUser(existingUser.id);

    const notLinkedMaxId = `${9500000000 + Math.floor(Math.random() * 1000000)}`;
    const contactRes = await request(app)
      .post('/auth/max/contact')
      .send({
        maxSessionToken: issueMaxSessionToken(notLinkedMaxId, 'max_need_link_user'),
        phoneE164: existingPhone,
      });

    expect(contactRes.status).toBe(200);
    expect(contactRes.body?.ok).toBe(true);
    expect(contactRes.body?.data?.state).toBe('READY');
    expect(contactRes.body?.data?.conflictUserHint).toBeNull();

    const maxOwner = await prisma.user.findFirst({
      where: { maxId: BigInt(notLinkedMaxId) },
      select: { id: true, maxLinkedAt: true, authProvider: true },
    });
    expect(maxOwner?.id).toBe(existingUser.id);
    expect(maxOwner?.maxLinkedAt).toBeTruthy();
    expect(maxOwner?.authProvider).toBe('HYBRID');
  });

  it('keeps NEED_LINK fallback when phone owner already has another MAX ID', async () => {
    const existingPhone = '+79990006678';
    const existingEmail = `${uniq('phone_owner_conflict')}@example.com`;
    const existingMaxId = BigInt('888800000001');
    const existingUser = await prisma.user.create({
      data: {
        email: existingEmail,
        passwordHash: await bcrypt.hash('OwnerPass123!', 10),
        roleId: userRoleId,
        isActive: true,
        authProvider: 'HYBRID',
        profileStatus: 'ACTIVE',
        phone: BigInt('79990006678'),
        maxId: existingMaxId,
        maxUsername: 'already_linked_max',
        maxLinkedAt: new Date(),
      },
      select: { id: true },
    });
    trackUser(existingUser.id);

    const incomingMaxId = `${9500001000 + Math.floor(Math.random() * 1000000)}`;
    const contactRes = await request(app)
      .post('/auth/max/contact')
      .send({
        maxSessionToken: issueMaxSessionToken(incomingMaxId, 'max_need_link_conflict'),
        phoneE164: existingPhone,
      });

    expect(contactRes.status).toBe(200);
    expect(contactRes.body?.ok).toBe(true);
    expect(contactRes.body?.data?.state).toBe('NEED_LINK');
    expect(contactRes.body?.data?.conflictUserHint).toBeTruthy();

    const unchangedOwner = await prisma.user.findUnique({
      where: { id: existingUser.id },
      select: { maxId: true },
    });
    expect(unchangedOwner?.maxId?.toString()).toBe(existingMaxId.toString());

    const unexpectedOwner = await prisma.user.findFirst({
      where: { maxId: BigInt(incomingMaxId) },
      select: { id: true },
    });
    expect(unexpectedOwner).toBeNull();
  });
});
