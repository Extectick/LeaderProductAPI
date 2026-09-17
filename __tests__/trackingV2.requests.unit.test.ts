import express from 'express';
import request from 'supertest';
const mockPrisma = {
  trackingDeviceToken: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  trackingLocationRequest: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  routePoint: { findFirst: jest.fn(), findMany: jest.fn() },
  orderGeoEvent: { findMany: jest.fn() },
  auditLog: { create: jest.fn() },
};
let mockViewer = { userId: 7, role: 'admin', permissions: [] };
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../src/middleware/auth', () => ({ authenticateToken: (req: any, _res: any, next: () => void) => { req.user = mockViewer; next(); } }));
jest.mock('../src/middleware/checkUserStatus', () => ({ checkUserStatus: (_req: any, _res: any, next: () => void) => next() }));
jest.mock('../src/middleware/serviceAccess', () => ({ authorizeServiceAccess: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock('../src/middleware/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock('../src/services/pushService', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../src/storage/minio', () => ({ resolveObjectUrl: jest.fn() }));
import router from '../src/routes/trackingV2';
import { sendPushToUser } from '../src/services/pushService';
const app = express();
app.use(express.json()); app.use('/tracking', router);
const pending = () => ({ id: 'request-1', targetUserId: 7, status: 'PENDING', requestedAt: new Date(), expiresAt: new Date(Date.now() + 30000), routePoint: null });
beforeEach(() => {
  jest.clearAllMocks();
  mockViewer = { userId: 7, role: 'admin', permissions: [] };
  mockPrisma.trackingDeviceToken.findFirst.mockResolvedValue({ id: 37 });
  mockPrisma.trackingLocationRequest.findFirst.mockResolvedValue(null);
  mockPrisma.trackingLocationRequest.create.mockImplementation(async () => pending());
  mockPrisma.trackingLocationRequest.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.routePoint.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.create.mockResolvedValue({});
  (sendPushToUser as jest.Mock).mockResolvedValue({ ok: true });
});

it('records a direct self request for this installation without requiring push', async () => {
  const response = await request(app).post('/tracking/users/7/location-requests').send({ localInstallId: 'this-phone' });
  expect(response.status).toBe(202);
  expect(response.body.data.status).toBe('PENDING');
  expect(mockPrisma.trackingDeviceToken.findFirst.mock.calls[0][0].where.installId).toBe('this-phone');
  expect(sendPushToUser).not.toHaveBeenCalled();
});

it('reports missing push immediately instead of claiming delivery and waiting for timeout', async () => {
  (sendPushToUser as jest.Mock).mockResolvedValue({ ok: false, reason: 'no_tokens' });
  const response = await request(app).post('/tracking/users/8/location-requests').send({ localInstallId: 'not-my-phone' });
  expect(response.body.data).toMatchObject({ status: 'FAILED', failureReason: 'DEVICE_UPDATE_REQUIRED' });
  expect(mockPrisma.trackingDeviceToken.findFirst.mock.calls[0][0].where.installId).toBeUndefined();
  expect(mockPrisma.trackingLocationRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'request-1', status: 'PENDING' }, data: expect.objectContaining({ failureReason: 'DEVICE_UPDATE_REQUIRED' }) }));
});

it('queues a native command without any push registration', async () => {
  mockPrisma.trackingDeviceToken.findFirst.mockResolvedValue({ id: 37, lastCommandPollAt: new Date() });
  const response = await request(app).post('/tracking/users/8/location-requests').send({});
  expect(response.body.data).toMatchObject({ status: 'PENDING', delivery: 'native_poll', failureReason: null });
  expect(sendPushToUser).not.toHaveBeenCalled();
  expect(mockPrisma.trackingDeviceToken.findFirst.mock.calls[0][0].orderBy[0]).toEqual({ lastCommandPollAt: { sort: 'desc', nulls: 'last' } });
});

it('reports command connection independently of old GPS coordinates', async () => {
  const old = new Date(Date.now() - 3600_000);
  const recent = new Date();
  mockPrisma.routePoint.findFirst.mockResolvedValue({ id: 1, recordedAt: old, latitude: 55, longitude: 73 });
  mockPrisma.trackingDeviceToken.findFirst.mockResolvedValue({ trackingEnabled: true, lastUsedAt: old, lastCommandPollAt: recent });
  const response = await request(app).get('/tracking/users/7/live');
  expect(response.body.data.device).toMatchObject({ lastCommandPollAt: recent.toISOString(), commandChannelOnline: true, stale: true });
  expect(response.body.data.point.recordedAt).toBe(old.toISOString());
  expect(response.body.data.point.ageSeconds).toBeGreaterThanOrEqual(3600);
});

it('falls back to the last active legacy phone when no recent command channel exists', async () => {
  mockPrisma.trackingDeviceToken.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 38 });
  await request(app).post('/tracking/users/8/location-requests').send({});
  expect(mockPrisma.trackingDeviceToken.findFirst.mock.calls[0][0].where.lastCommandPollAt).toEqual({ gte: expect.any(Date) });
  expect(mockPrisma.trackingDeviceToken.findFirst.mock.calls[1][0].where.lastCommandPollAt).toBeUndefined();
  expect(mockPrisma.trackingLocationRequest.create.mock.calls[0][0].data.trackingDeviceTokenId).toBe(38);
});

describe('native command polling', () => {
  beforeEach(() => {
    mockPrisma.trackingDeviceToken.findUnique.mockResolvedValue({ id: 37, userId: 8, trackingEnabled: true, user: { isActive: true, profileStatus: 'ACTIVE' } });
    mockPrisma.trackingDeviceToken.update.mockResolvedValue({});
    mockPrisma.trackingLocationRequest.findFirst.mockResolvedValue(pending());
  });
  it('returns only this device command and records command liveness separately from GPS', async () => {
    const response = await request(app).post('/tracking/native/commands').send({ credential: 'lpt_scoped' });
    expect(response.status).toBe(200);
    expect(response.body.command.id).toBe('request-1');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mockPrisma.trackingLocationRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ trackingDeviceTokenId: 37, targetUserId: 8, status: 'PENDING', expiresAt: { gt: expect.any(Date) } }) }));
    expect(mockPrisma.trackingDeviceToken.update).toHaveBeenCalledWith({ where: { id: 37 }, data: { lastCommandPollAt: expect.any(Date) } });
    expect(mockPrisma.routePoint.findMany).not.toHaveBeenCalled();
  });
  it('rejects invalid, expired or disabled credentials and rate-limits rapid repeats', async () => {
    expect((await request(app).post('/tracking/native/commands').send({})).status).toBe(401);
    mockPrisma.trackingDeviceToken.findUnique.mockResolvedValueOnce(null);
    expect((await request(app).post('/tracking/native/commands').send({ credential: 'lpt_unknown' })).status).toBe(401);
    mockPrisma.trackingDeviceToken.findUnique.mockResolvedValueOnce({ revokedAt: new Date() });
    expect((await request(app).post('/tracking/native/commands').send({ credential: 'lpt_revoked' })).status).toBe(403);
    mockPrisma.trackingDeviceToken.findUnique.mockResolvedValueOnce({ trackingEnabled: true, expiresAt: new Date(0) });
    expect((await request(app).post('/tracking/native/commands').send({ credential: 'lpt_expired' })).status).toBe(403);
    mockPrisma.trackingDeviceToken.findUnique.mockResolvedValueOnce({ trackingEnabled: true, user: { isActive: true, profileStatus: 'ACTIVE' }, lastCommandPollAt: new Date() });
    expect((await request(app).post('/tracking/native/commands').send({ credential: 'lpt_fast' })).status).toBe(429);
  });
  it('allows a failure acknowledgement only for this device pending, unexpired request', async () => {
    await request(app).post('/tracking/native/commands').send({ credential: 'lpt_scoped', failure: { requestId: 'request-1', reason: 'LOCATION_SERVICES_DISABLED' } });
    expect(mockPrisma.trackingLocationRequest.updateMany).toHaveBeenCalledWith({ where: { id: 'request-1', trackingDeviceTokenId: 37, status: 'PENDING', expiresAt: { gt: expect.any(Date) } }, data: { status: 'FAILED', completedAt: expect.any(Date), failureReason: 'LOCATION_SERVICES_DISABLED' } });
  });
});

it('rejects remote requests outside employee permissions', async () => {
  mockViewer.role = 'employee';
  expect((await request(app).post('/tracking/users/8/location-requests').send({ localInstallId: 'this-phone' })).status).toBe(403);
  expect(mockPrisma.trackingLocationRequest.create).not.toHaveBeenCalled();
});

it('does not overwrite a concurrently completed location request with a timeout', async () => {
  mockPrisma.trackingLocationRequest.findUnique.mockResolvedValueOnce({ ...pending(), expiresAt: new Date(Date.now() - 1) }).mockResolvedValueOnce({ ...pending(), status: 'SUCCEEDED' });
  mockPrisma.trackingLocationRequest.updateMany.mockResolvedValue({ count: 0 });
  const response = await request(app).get('/tracking/location-requests/request-1');
  expect(response.body.data.status).toBe('SUCCEEDED');
});

it('loads a bounded cursor page without loading the GPS route again', async () => {
  const records = Array.from({ length: 21 }, (_, id) => ({ id: `event-${id}`, capturedAt: new Date('2026-09-16T07:00:00Z'), eventType: 'CREATED', order: { guid: 'order-guid', number1c: '123', date1c: null, totalAmount: 100, counterparty: { name: 'Клиент' } } }));
  mockPrisma.orderGeoEvent.findMany.mockResolvedValue(records);
  const first = await request(app).get('/tracking/users/7/day/events?date=2026-09-16&eventLimit=20');
  expect(first.body.data.orderEvents).toHaveLength(20);
  expect(first.body.data.orderEventsNextCursor).toBeTruthy();
  await request(app).get('/tracking/users/7/day/events').query({ date: '2026-09-16', eventLimit: 20, eventCursor: first.body.data.orderEventsNextCursor });
  expect(mockPrisma.orderGeoEvent.findMany.mock.calls[1][0].where.OR).toContainEqual({ capturedAt: new Date('2026-09-16T07:00:00Z'), id: { gt: 'event-19' } });
  expect(mockPrisma.routePoint.findMany).not.toHaveBeenCalled();
});
