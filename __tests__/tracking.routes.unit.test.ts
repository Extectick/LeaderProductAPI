import express from 'express';
import request from 'supertest';

const mockTx = {
  userRoute: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  routePoint: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    createMany: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
  },
  trackingDeviceToken: {
    updateMany: jest.fn(),
    create: jest.fn(),
  },
};

const mockPrisma = {
  $transaction: jest.fn((callback: any) => callback(mockTx)),
  userRoute: {
    findFirst: jest.fn(),
  },
  routePoint: {
    findFirst: jest.fn(),
    count: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
  },
  trackingDeviceToken: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
};
let mockTrackingServiceAccessAllowed = true;

jest.mock('../src/prisma/client', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 7, permissions: [], profileStatus: 'ACTIVE' };
    next();
  },
}));

jest.mock('../src/middleware/checkUserStatus', () => ({
  checkUserStatus: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../src/middleware/serviceAccess', () => ({
  authorizeServiceAccess: () => (_req: any, res: any, next: any) => {
    if (!mockTrackingServiceAccessAllowed) {
      return res.status(403).json({
        ok: false,
        message: 'Доступ к сервису запрещён',
        error: { code: 'FORBIDDEN' },
      });
    }
    return next();
  },
}));

jest.mock('../src/middleware/rateLimit', () => ({
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

import trackingRouter from '../src/routes/tracking';

const app = express();
app.use(express.json());
app.use('/tracking', trackingRouter);

const point = {
  latitude: 55.03,
  longitude: 82.92,
  recordedAt: '2026-07-10T08:00:00.000Z',
  accuracy: 8,
};

describe('/tracking/points', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((callback: any) => callback(mockTx));
    mockTx.userRoute.findFirst.mockReset();
    mockTx.userRoute.create.mockReset();
    mockTx.userRoute.update.mockReset();
    mockTx.routePoint.findFirst.mockReset();
    mockTx.routePoint.findMany.mockReset();
    mockTx.routePoint.count.mockReset();
    mockTx.routePoint.createMany.mockReset();
    mockTx.auditLog.create.mockReset();
    mockTx.trackingDeviceToken.updateMany.mockReset();
    mockTx.trackingDeviceToken.create.mockReset();
    mockPrisma.userRoute.findFirst.mockReset();
    mockPrisma.routePoint.findFirst.mockReset();
    mockPrisma.routePoint.count.mockReset();
    mockPrisma.auditLog.create.mockReset();
    mockPrisma.trackingDeviceToken.findUnique.mockReset();
    mockPrisma.trackingDeviceToken.findFirst.mockReset();
    mockPrisma.trackingDeviceToken.findMany.mockReset();
    mockPrisma.trackingDeviceToken.count.mockReset();
    mockPrisma.trackingDeviceToken.update.mockReset();
    mockPrisma.trackingDeviceToken.updateMany.mockReset();
    mockTrackingServiceAccessAllowed = true;
  });

  it('skips already received clientPointId without creating duplicates', async () => {
    mockTx.userRoute.findFirst.mockResolvedValueOnce({
      id: 10,
      userId: 7,
      status: 'ACTIVE',
      startedAt: new Date('2026-07-10T08:00:00.000Z'),
      endedAt: null,
    });
    mockTx.routePoint.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockTx.routePoint.findMany.mockResolvedValueOnce([{ clientPointId: 'point-1' }]);

    const response = await request(app)
      .post('/tracking/points')
      .send({
        routeId: 10,
        points: [{ ...point, clientPointId: 'point-1' }],
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      routeId: 10,
      createdPoints: 0,
      routeStatus: 'ACTIVE',
    });
    expect(mockTx.routePoint.createMany).not.toHaveBeenCalled();
  });

  it('persists clientPointId and completes route when endRoute is sent', async () => {
    mockTx.userRoute.findFirst.mockResolvedValueOnce({
      id: 44,
      userId: 7,
      status: 'ACTIVE',
      startedAt: new Date('2026-07-10T08:00:00.000Z'),
      endedAt: null,
    });
    mockTx.routePoint.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockTx.routePoint.findMany.mockResolvedValueOnce([]);
    mockTx.routePoint.count.mockResolvedValueOnce(0);
    mockTx.routePoint.createMany.mockResolvedValueOnce({ count: 1 });
    mockTx.userRoute.update.mockResolvedValueOnce({ id: 44, userId: 7, status: 'COMPLETED' });

    const response = await request(app)
      .post('/tracking/points')
      .send({
        routeId: 44,
        endRoute: true,
        points: [{
          ...point,
          clientPointId: 'point-2',
          eventType: 'STOP',
          recordedTimeZone: 'Asia/Novosibirsk',
          recordedTimezoneOffsetMinutes: 420,
        }],
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      routeId: 44,
      createdPoints: 1,
      routeStatus: 'COMPLETED',
    });
    expect(mockTx.routePoint.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          routeId: 44,
          userId: 7,
          clientPointId: 'point-2',
          eventType: 'STOP',
          recordedTimeZone: 'Asia/Novosibirsk',
          recordedTimezoneOffsetMinutes: 420,
          sequence: 1,
        }),
      ],
      skipDuplicates: true,
    });
    expect(mockTx.userRoute.update).toHaveBeenCalledWith({
      where: { id: 44 },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    });
  });

  it('filters unusable accuracy before it creates a route point', async () => {
    mockTx.userRoute.findFirst.mockResolvedValueOnce({
      id: 46,
      userId: 7,
      status: 'ACTIVE',
      startedAt: new Date('2026-07-10T08:00:00.000Z'),
      endedAt: null,
    });
    mockTx.routePoint.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockTx.routePoint.findMany.mockResolvedValueOnce([]);

    const response = await request(app)
      .post('/tracking/points')
      .send({
        routeId: 46,
        points: [{ ...point, clientPointId: 'too-inaccurate', accuracy: 150 }],
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ routeId: 46, createdPoints: 0 });
    expect(mockTx.routePoint.createMany).not.toHaveBeenCalled();
    expect(mockTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ details: expect.stringContaining('rejectedAccuracyPoints') }),
    });
  });

  it('backfills active route start from the first point before completing it', async () => {
    const startedAt = new Date('2026-07-10T12:00:00.000Z');
    const pointRecordedAt = new Date(point.recordedAt);
    mockTx.userRoute.findFirst.mockResolvedValueOnce({
      id: 45,
      userId: 7,
      status: 'ACTIVE',
      startedAt,
      endedAt: null,
    });
    mockTx.routePoint.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockTx.routePoint.findMany.mockResolvedValueOnce([]);
    mockTx.routePoint.count.mockResolvedValueOnce(0);
    mockTx.userRoute.update
      .mockResolvedValueOnce({
        id: 45,
        userId: 7,
        status: 'ACTIVE',
        startedAt: pointRecordedAt,
        endedAt: null,
      })
      .mockResolvedValueOnce({
        id: 45,
        userId: 7,
        status: 'COMPLETED',
        startedAt: pointRecordedAt,
        endedAt: pointRecordedAt,
      });
    mockTx.routePoint.createMany.mockResolvedValueOnce({ count: 1 });

    const response = await request(app)
      .post('/tracking/points')
      .send({
        routeId: 45,
        endRoute: true,
        points: [{ ...point, clientPointId: 'point-backfill', eventType: 'STOP' }],
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      routeId: 45,
      createdPoints: 1,
      routeStatus: 'COMPLETED',
    });
    expect(mockTx.userRoute.update).toHaveBeenNthCalledWith(1, {
      where: { id: 45 },
      data: { startedAt: pointRecordedAt },
    });
    expect(mockTx.userRoute.update).toHaveBeenNthCalledWith(2, {
      where: { id: 45 },
      data: {
        status: 'COMPLETED',
        endedAt: pointRecordedAt,
      },
    });
  });
});

describe('/tracking native token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((callback: any) => callback(mockTx));
    mockTx.trackingDeviceToken.updateMany.mockResolvedValue({ count: 1 });
    mockTx.trackingDeviceToken.create.mockResolvedValue({ id: 1 });
    mockPrisma.trackingDeviceToken.findUnique.mockReset();
    mockPrisma.trackingDeviceToken.findFirst.mockReset();
    mockPrisma.trackingDeviceToken.findMany.mockReset();
    mockPrisma.trackingDeviceToken.count.mockReset();
    mockPrisma.trackingDeviceToken.update.mockResolvedValue({});
    mockPrisma.trackingDeviceToken.updateMany.mockResolvedValue({ count: 1 });
    mockTx.userRoute.findFirst.mockReset();
    mockTx.userRoute.create.mockReset();
    mockTx.userRoute.update.mockReset();
    mockTx.routePoint.findFirst.mockReset();
    mockTx.routePoint.findMany.mockReset();
    mockTx.routePoint.count.mockReset();
    mockTx.routePoint.createMany.mockReset();
    mockTx.auditLog.create.mockReset();
    mockTrackingServiceAccessAllowed = true;
  });

  it('issues a scoped native tracking token without storing the raw token', async () => {
    const response = await request(app)
      .post('/tracking/native-token')
      .send({
        installId: 'install-1',
        deviceSessionId: 'device-1',
        platform: 'android',
        appVersion: '0.1.20',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.token).toMatch(/^lpt_/);
    expect(response.body.data.endpoint).toBe('/tracking/native/points');
    expect(mockTx.trackingDeviceToken.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 7,
        revokedAt: null,
        OR: [{ installId: 'install-1' }, { deviceSessionId: 'device-1' }],
      },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockTx.trackingDeviceToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenHash: expect.any(String),
        userId: 7,
        installId: 'install-1',
        deviceSessionId: 'device-1',
        platform: 'android',
        appVersion: '0.1.20',
      }),
    });
    expect(mockTx.trackingDeviceToken.create.mock.calls[0][0].data.tokenHash).not.toBe(
      response.body.data.token
    );
  });

  it('records the reason when a device token replaces an active installation token', async () => {
    const response = await request(app)
      .post('/tracking/native-token')
      .send({ installId: 'install-1', reason: 'token_invalid' });

    expect(response.status).toBe(200);
    expect(mockTx.trackingDeviceToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ issueReason: 'token_invalid' }),
    });
    expect(mockTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 7,
        details: expect.stringContaining('TOKEN_ISSUED'),
      }),
    });
  });

  it('rejects a token churn loop before it replaces another active token', async () => {
    mockPrisma.trackingDeviceToken.count.mockResolvedValueOnce(3);

    const response = await request(app)
      .post('/tracking/native-token')
      .send({ installId: 'install-1', reason: 'repair' });

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'TOO_MANY_REQUESTS' },
    });
    expect(mockTx.trackingDeviceToken.create).not.toHaveBeenCalled();
  });

  it('rejects native points with an invalid scoped token', async () => {
    mockPrisma.trackingDeviceToken.findUnique.mockResolvedValueOnce(null);

    const response = await request(app)
      .post('/tracking/native/points')
      .set('Authorization', 'Bearer lpt_invalid')
      .send({ points: [point] });

    expect(response.status).toBe(401);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts native points with a valid scoped token', async () => {
    mockPrisma.trackingDeviceToken.findUnique.mockResolvedValueOnce({
      id: 12,
      userId: 7,
      revokedAt: null,
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      user: { id: 7, isActive: true, profileStatus: 'ACTIVE' },
    });
    mockTx.userRoute.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockTx.userRoute.create.mockResolvedValueOnce({
      id: 77,
      userId: 7,
      status: 'ACTIVE',
      startedAt: new Date(point.recordedAt),
      endedAt: null,
    });
    mockTx.routePoint.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockTx.routePoint.findMany.mockResolvedValueOnce([]);
    mockTx.routePoint.count.mockResolvedValueOnce(0);
    mockTx.routePoint.createMany.mockResolvedValueOnce({ count: 1 });

    const response = await request(app)
      .post('/tracking/native/points')
      .set('Authorization', 'Bearer lpt_valid')
      .send({ startNewRoute: true, points: [{ ...point, clientPointId: 'native-1' }] });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      routeId: 77,
      createdPoints: 1,
      routeStatus: 'ACTIVE',
    });
    expect(mockPrisma.trackingDeviceToken.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { lastUsedAt: expect.any(Date) },
    });
  });
});

describe('/tracking service access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTrackingServiceAccessAllowed = false;
  });

  afterEach(() => {
    mockTrackingServiceAccessAllowed = true;
  });

  it('rejects session start when user has no tracking service access', async () => {
    const response = await request(app).post('/tracking/sessions/start').send({});

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects status and points when user has no tracking service access', async () => {
    const statusResponse = await request(app).get('/tracking/status');
    const pointsResponse = await request(app)
      .post('/tracking/points')
      .send({ points: [point] });

    expect(statusResponse.status).toBe(403);
    expect(pointsResponse.status).toBe(403);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not expose operational device health to a regular tracking user', async () => {
    mockTrackingServiceAccessAllowed = true;
    const response = await request(app).get('/tracking/admin/health');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
  });
});

describe('/tracking/sessions and status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((callback: any) => callback(mockTx));
    mockTx.userRoute.findFirst.mockReset();
    mockTx.userRoute.create.mockReset();
    mockTx.userRoute.update.mockReset();
    mockTx.routePoint.findFirst.mockReset();
    mockTx.routePoint.count.mockReset();
    mockTx.auditLog.create.mockReset();
    mockPrisma.userRoute.findFirst.mockReset();
    mockPrisma.routePoint.findFirst.mockReset();
    mockPrisma.routePoint.count.mockReset();
    mockPrisma.auditLog.create.mockReset();
  });

  it('starts a tracking session by reusing an active route', async () => {
    mockTx.userRoute.findFirst.mockResolvedValueOnce({
      id: 90,
      userId: 7,
      status: 'ACTIVE',
      startedAt: new Date('2026-07-10T08:00:00.000Z'),
      endedAt: null,
    });
    mockPrisma.routePoint.count.mockResolvedValueOnce(3);

    const response = await request(app).post('/tracking/sessions/start').send({});

    expect(response.status).toBe(200);
    expect(response.body.data.route).toMatchObject({
      id: 90,
      status: 'ACTIVE',
      pointsCount: 3,
    });
    expect(mockTx.userRoute.create).not.toHaveBeenCalled();
    expect(mockTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 7,
        targetType: 'USER_ROUTE',
        targetId: 90,
      }),
    });
  });

  it('stops the active tracking session at the last point time', async () => {
    mockTx.userRoute.findFirst.mockResolvedValueOnce({
      id: 91,
      userId: 7,
      status: 'ACTIVE',
      startedAt: new Date('2026-07-10T08:00:00.000Z'),
      endedAt: null,
    });
    mockTx.routePoint.findFirst.mockResolvedValueOnce({
      recordedAt: new Date('2026-07-10T08:15:00.000Z'),
    }).mockResolvedValueOnce({
      recordedAt: new Date('2026-07-10T08:00:00.000Z'),
    });
    mockTx.userRoute.update.mockResolvedValueOnce({
      id: 91,
      userId: 7,
      status: 'COMPLETED',
      startedAt: new Date('2026-07-10T08:00:00.000Z'),
      endedAt: new Date('2026-07-10T08:15:00.000Z'),
    });
    mockPrisma.routePoint.count.mockResolvedValueOnce(5);

    const response = await request(app).post('/tracking/sessions/stop').send({});

    expect(response.status).toBe(200);
    expect(response.body.data.route).toMatchObject({
      id: 91,
      status: 'COMPLETED',
      pointsCount: 5,
    });
    expect(mockTx.userRoute.update).toHaveBeenCalledWith({
      where: { id: 91 },
      data: {
        status: 'COMPLETED',
        endedAt: new Date('2026-07-10T08:15:00.000Z'),
      },
    });
  });

  it('returns current tracking status', async () => {
    const route = {
      id: 92,
      userId: 7,
      status: 'ACTIVE',
      startedAt: new Date('2026-07-10T08:00:00.000Z'),
      endedAt: null,
    };
    const lastPoint = {
      id: 500,
      routeId: 92,
      latitude: 55.03,
      longitude: 82.92,
      recordedAt: new Date('2026-07-10T08:10:00.000Z'),
      eventType: 'MOVE',
      accuracy: 7,
      speed: null,
      heading: null,
      stayDurationSeconds: null,
      sequence: 4,
    };
    mockPrisma.userRoute.findFirst
      .mockResolvedValueOnce(route)
      .mockResolvedValueOnce(route);
    mockPrisma.routePoint.findFirst.mockResolvedValueOnce(lastPoint);
    mockPrisma.routePoint.count
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(4);
    mockPrisma.trackingDeviceToken.findFirst.mockResolvedValueOnce({
      id: 8,
      installId: 'install-1',
      platform: 'android',
      appVersion: '0.1.23',
      lastUsedAt: new Date(),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    mockPrisma.trackingDeviceToken.count.mockResolvedValueOnce(1);

    const response = await request(app).get('/tracking/status');

    expect(response.status).toBe(200);
    expect(response.body.data.activeRoute).toMatchObject({
      id: 92,
      status: 'ACTIVE',
      pointsCount: 4,
    });
    expect(response.body.data.todayPointsCount).toBe(8);
    expect(response.body.data.lastPoint).toMatchObject({
      id: 500,
      routeId: 92,
      latitude: 55.03,
    });
    expect(response.body.data.nativeDevice).toMatchObject({
      active: true,
      installId: 'install-1',
      stale: false,
      tokenIssueCountLastHour: 1,
    });
  });
});
