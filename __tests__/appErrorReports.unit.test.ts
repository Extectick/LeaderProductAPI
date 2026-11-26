import express from 'express';
import request from 'supertest';
import prisma from '../src/prisma/client';
import { appErrorReportsRouter } from '../src/modules/monitoring/appErrorReports';
import { startCrashRetention, stopCrashRetention } from '../src/modules/monitoring/crashRetention';

jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  $transaction: jest.fn(), $queryRaw: jest.fn(), appCrashEvent: { findMany: jest.fn(), deleteMany: jest.fn() },
} }));
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req: any, res: express.Response, next: express.NextFunction) => {
    if (!req.get('Authorization')) return res.sendStatus(401);
    req.user = { userId: Number(req.get('test-user') ?? 33), role: req.get('test-role') };
    next();
  },
  authorizeRoles: (roles: string[]) => (req: any, res: express.Response, next: express.NextFunction) =>
    roles.includes(req.user.role) ? next() : res.sendStatus(403),
}));
jest.mock('../src/middleware/checkUserStatus', () => ({
  checkUserStatus: (req: express.Request, res: express.Response, next: express.NextFunction) =>
    req.get('test-blocked') ? res.sendStatus(403) : next(),
}));

const path = '/api/diagnostics/app-errors';
const app = express().use(path, appErrorReportsRouter);
const id = 'f396fff1-03ed-4bfd-a099-41bb0aae18b7';
const payload = () => ({
  eventId: id, occurredAt: new Date().toISOString(), kind: 'maximum_update_depth',
  source: 'react_boundary', screen: 'orders', stage: 'editor-items', platform: 'android',
  appVersion: '0.1.37.2', runtimeVersion: '0.1.37', buildNumber: '35', otaUpdateId: id,
  components: ['ClientOrdersScreen', 'OrderEditor.Items', 'RCTView'], jsFrames: ['1:2345'],
});
const db = jest.mocked(prisma);
const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn() };
const post = () => request(app).post(path).set('Authorization', 'Bearer unit');
const get = () => request(app).get(path).set('Authorization', 'Bearer unit').set('test-role', 'admin');
const previousFlags = {
  reporting: process.env.APP_ERROR_REPORTING_ENABLED, environment: process.env.APP_ERROR_REPORTING_ENVIRONMENT,
  sentry: process.env.APP_CRASH_REPORTING_ENABLED,
};
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.APP_CRASH_REPORTING_ENABLED;
  process.env.APP_ERROR_REPORTING_ENABLED = 'true';
  process.env.APP_ERROR_REPORTING_ENVIRONMENT = 'development';
  db.$transaction.mockImplementation((callback: any) => callback(tx));
  tx.$queryRaw.mockResolvedValue([{ duplicate: false, exhausted: false }]);
});
afterAll(() => {
  for (const [key, value] of Object.entries({
    APP_ERROR_REPORTING_ENABLED: previousFlags.reporting,
    APP_ERROR_REPORTING_ENVIRONMENT: previousFlags.environment,
    APP_CRASH_REPORTING_ENABLED: previousFlags.sentry,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('ingests an authenticated report while Sentry is disabled and stores only structured details', async () => {
  await post().set('test-user', '7').send(payload()).expect(204).expect('Cache-Control', 'no-store');
  const [, , project, eventId, environment, , title, level, platform, userId, , , , , screen, details] = tx.$executeRaw.mock.calls[1];
  expect({ project, environment, title, level, platform, userId, screen }).toEqual({
    project: 'leaderproduct-app-errors', environment: 'development', title: 'Maximum update depth exceeded', level: 'error',
    platform: 'android', userId: '7', screen: 'orders',
  });
  expect(eventId).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.parse(details)).toEqual({ eventId: id, kind: 'maximum_update_depth', source: 'react_boundary',
    stage: 'editor-items', components: payload().components, jsFrames: ['1:2345'] });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted' });
});

test('allows non-order reports and an absent stack; supports seven days offline', async () => {
  const occurredAt = new Date(Date.now() - 7 * 86400000).toISOString();
  await post().send({ eventId: id, occurredAt, kind: 'type_error', source: 'global_js',
    screen: 'help', platform: 'web', stage: 'unknown', components: [], jsFrames: [] }).expect(204);
});
const nativeReport = () => ({ ...payload(), kind: 'java_exception', source: 'android_native', screen: 'unknown', stage: 'unknown',
  nativeEvidence: { androidApi: 28, exceptionClass: 'java.lang.ClassCastException', frames: ['com.example.App$Inner.run:19'] } });
test.each(['java_exception', 'native_crash', 'anr'])('preserves bounded Android native evidence for %s', async kind => {
  const report = { ...nativeReport(), kind };
  await post().send(report).expect(204);
  const inserted = tx.$executeRaw.mock.calls[1];
  expect(JSON.parse(inserted[inserted.length - 1])).toMatchObject({ kind, nativeEvidence: report.nativeEvidence });
});
test.each([
  { nativeEvidence: undefined }, { source: 'global_js' }, { platform: 'web' }, { kind: 'error' },
  { nativeEvidence: { androidApi: 28, secret: 'raw' } }, { nativeEvidence: { androidApi: 28, frames: ['at Foo(query=private)'] } },
  { nativeEvidence: { androidApi: 28, frames: Array(17).fill('java.lang.Thread.run') } },
  { nativeEvidence: { androidApi: 28, signal: -1 } }, { nativeEvidence: { androidApi: 28, exitReason: 300 } },
])('rejects mismatched or unsafe native evidence (%j)', async invalid => {
  await post().send({ ...nativeReport(), ...invalid }).expect(400);
  expect(db.$transaction).not.toHaveBeenCalled();
});
test('flags, authentication and account status are enforced before writing', async () => {
  await request(app).post(path).send(payload()).expect(401);
  await post().set('test-blocked', 'yes').send(payload()).expect(403);
  delete process.env.APP_ERROR_REPORTING_ENABLED;
  process.env.APP_CRASH_REPORTING_ENABLED = 'true';
  await post().send(payload()).expect(404);
  expect(db.$transaction).not.toHaveBeenCalled();
});
test.each([
  { message: 'raw error' }, { userId: 77 }, { components: ['file:///some/file?query'] },
  { components: ['Customer Name'] }, { components: Array(33).fill('RCTView') },
  { jsFrames: ['http://test?query'] }, { jsFrames: Array(25).fill('1:1') }, { appVersion: '1.2#secret' },
  { occurredAt: '2001-01-01T00:00:00Z' }, { occurredAt: '2099-01-01T00:00:00Z' },
  { eventId: 'invalid' }, { screen: '/orders/17' }, { source: 'unsupported' }, { kind: 'Error: private text' },
])('rejects unsafe, stale or malformed fields (%j)', async invalid => {
  await post().send({ ...payload(), ...invalid }).expect(400);
  expect(db.$transaction).not.toHaveBeenCalled();
});
test('handles invalid JSON and the byte limit without reflecting body contents', async () => {
  const invalid = await post().type('json').send('{"customer":"sensitive",}').expect(400);
  expect(invalid.text).not.toContain('sensitive');
  await post().send({ extra: 'x'.repeat(9000) }).expect(413);
  expect(db.$transaction).not.toHaveBeenCalled();
});
test('duplicates are accepted even after reaching quota; a distinct event is throttled before insertion', async () => {
  tx.$queryRaw.mockResolvedValueOnce([{ duplicate: true, exhausted: true }]);
  await post().send(payload()).expect(204);
  tx.$queryRaw.mockResolvedValueOnce([{ duplicate: false, exhausted: true }]);
  await post().send(payload()).expect(429).expect('Retry-After', '3600');
  expect(tx.$executeRaw).toHaveBeenCalledTimes(2); // only the two transaction locks
});
test('the same local event ID from two authenticated users produces distinct deduplication keys', async () => {
  await post().set('test-user', '7').send(payload()).expect(204);
  await post().set('test-user', '8').send(payload()).expect(204);
  expect(tx.$executeRaw.mock.calls[1][3]).not.toEqual(tx.$executeRaw.mock.calls[3][3]);
});
test('admin-only listing paginates with a stable keyset cursor, supports exact-match filters', async () => {
  const occurredAt = new Date();
  const row = { id, occurredAt, details: { eventId: id } };
  db.$queryRaw.mockResolvedValueOnce([row, { ...row, id: 'another-row' }]).mockResolvedValueOnce([]);
  await request(app).get(path).set('Authorization', 'Bearer unit').expect(403);
  const first = await get().query({ limit: '1', kind: 'maximum_update_depth', screen: 'orders' }).expect(200);
  expect(first.body.items).toHaveLength(1);
  expect(first.body.nextCursor).toBe(occurredAt.toISOString() + '|' + id);
  expect((await get().query({ limit: '1', cursor: first.body.nextCursor, eventId: id }).expect(200)).body)
    .toEqual({ items: [], nextCursor: null });
  for (const invalid of [{ cursor: 'bad' }, { limit: '200' }, { stage: 'all' }, { user: 'private' }])
    await get().query(invalid).expect(400);
  expect(db.$queryRaw).toHaveBeenCalledTimes(2);
});
test('a storage outage is retryable and does not echo internal details', async () => {
  db.$transaction.mockRejectedValueOnce(new Error('secret'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = await post().send(payload()).expect(503);
    expect(result.text).not.toContain('secret');
    expect(warn).toHaveBeenCalledWith('[monitoring] app error report storage unavailable');
  } finally { warn.mockRestore(); }
});
test('when only first-party reporting is enabled retention removes only its own old reports', async () => {
  jest.useFakeTimers();
  try {
    db.appCrashEvent.findMany.mockResolvedValueOnce([] as never);
    startCrashRetention();
    await jest.advanceTimersByTimeAsync(3600000);
    expect(db.appCrashEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { project: 'leaderproduct-app-errors', occurredAt: { lt: new Date(Date.now() - 30 * 86400000) } },
    }));
  } finally {
    stopCrashRetention();
    jest.useRealTimers();
  }
});

test('stores numeric performance evidence with its own hourly budget and rejects arbitrary telemetry', async () => {
  const timing = {metric:'input_dispatch', durationMs:1200};
  const body = {...payload(), kind:'slow_operation', source:'performance', components:[], jsFrames:[], timing};
  await post().send(body).expect(204);
  expect(tx.$queryRaw.mock.calls[0]).toEqual(expect.arrayContaining(['warning', 3]));
  expect(tx.$executeRaw.mock.calls[1]).toEqual(expect.arrayContaining(['warning','Slow order interaction']));
  expect(JSON.parse(tx.$executeRaw.mock.calls[1][tx.$executeRaw.mock.calls[1].length - 1])).toMatchObject({timing});
  for (const invalid of [{kind:'error'}, {source:'captured'}, {components:['PersonalData']}, {screen:'help'},
    {timing:{...timing, extra:'private'}}, {timing:{...timing, durationMs:150000}}, {timing:{...timing,metric:'custom'}}]) {
    await post().send({...body, ...invalid}).expect(400);
  }
});
