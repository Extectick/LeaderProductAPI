import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';

jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  appCrashEvent: { upsert: jest.fn(), findMany: jest.fn() },
} }));
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => req.headers.authorization ? next() : res.sendStatus(401),
  authorizeRoles: () => (req: any, res: any, next: any) => req.headers.authorization === 'Bearer admin' ? next() : res.sendStatus(403),
}));
jest.mock('../src/middleware/checkUserStatus', () => ({ checkUserStatus: (_req: any, _res: any, next: any) => next() }));

import prisma from '../src/prisma/client';
import { crashEventsRouter, sentryWebhookRouter } from '../src/modules/monitoring/monitoring.routes';

const app = express();
app.use('/hook', sentryWebhookRouter);
app.use(express.json());
app.use('/events', crashEventsRouter);
const secret = 'unit-test-secret-'.repeat(4);
const payload = JSON.stringify({ project: { slug: 'dev' }, event: { eventID: 'a'.repeat(32), environment: 'development', dateCreated: '2026-09-01T00:00:00Z' } });
const signature = createHmac('sha256', secret).update(payload).digest('hex');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.APP_CRASH_REPORTING_ENABLED = 'true';
  process.env.SENTRY_PROJECT_SLUG = 'dev';
  process.env.SENTRY_EXPECTED_ENVIRONMENT = 'development';
  process.env.SENTRY_WEBHOOK_SECRET = secret;
  (prisma.appCrashEvent.upsert as jest.Mock).mockResolvedValue({});
  (prisma.appCrashEvent.findMany as jest.Mock).mockResolvedValue([]);
});

test('disabled endpoint is closed; forged signatures never reach database', async () => {
  await request(app).post('/hook').type('json').send(payload).expect(401);
  process.env.APP_CRASH_REPORTING_ENABLED = 'false';
  await request(app).post('/hook').type('json').send(payload).expect(404);
  expect(prisma.appCrashEvent.upsert).not.toHaveBeenCalled();
});

test('repeated valid delivery uses the same compound key and empty update', async () => {
  for (let i = 0; i < 2; i++) await request(app).post('/hook').type('json').set('X-ServiceHook-Signature', signature).send(payload).expect(204);
  expect(prisma.appCrashEvent.upsert).toHaveBeenCalledTimes(2);
  expect((prisma.appCrashEvent.upsert as jest.Mock).mock.calls[0][0]).toEqual((prisma.appCrashEvent.upsert as jest.Mock).mock.calls[1][0]);
  expect((prisma.appCrashEvent.upsert as jest.Mock).mock.calls[0][0].update).toEqual({});
});

test('failed durable storage is not acknowledged', async () => {
  (prisma.appCrashEvent.upsert as jest.Mock).mockRejectedValueOnce(new Error('db unavailable'));
  await request(app).post('/hook').type('json').set('X-ServiceHook-Signature', signature).send(payload).expect(503);
});

test('event reads require administrator and pagination is bounded', async () => {
  await request(app).get('/events').expect(401);
  await request(app).get('/events').set('Authorization', 'Bearer employee').expect(403);
  await request(app).get('/events?limit=9999').set('Authorization', 'Bearer admin').expect(200);
  expect(prisma.appCrashEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101 }));
});
