import express from 'express';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import router from '../src/routes/ota';
import { resolveOtaExpoConfig, validateOtaExpoConfig } from '../src/utils/otaExpoConfig';

const findMany = jest.fn();
const findUnique = jest.fn();
const aggregate = jest.fn();
const upsert = jest.fn();
const resolveUrl = jest.fn(async (key: string) => `https://assets.example.test/${key}`);
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { appOtaUpdate: {
  findMany: (...args: unknown[]) => findMany(...args),
  findUnique: (...args: unknown[]) => findUnique(...args),
  aggregate: (...args: unknown[]) => aggregate(...args),
  upsert: (...args: unknown[]) => upsert(...args),
} } }));
jest.mock('../src/storage/minio', () => ({
  resolveObjectUrl: (...args: [string]) => resolveUrl(...args), deleteObject: jest.fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorizePermissions: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../src/middleware/checkUserStatus', () => ({
  checkUserStatus: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const app = express();
app.use(express.json());
app.use('/ota', router);
const config = {
  name: 'Лидер Продукт', slug: 'leader-product', scheme: 'leaderproduct',
  version: '0.1.33', runtimeVersion: '0.1.33',
  android: { package: 'com.leaderproduct.app', versionCode: 32 },
  ios: { bundleIdentifier: 'com.leaderproduct.app', buildNumber: '32' },
  extra: { router: {}, eas: { projectId: 'project' } },
};
const release = (metadata: unknown = {}) => ({
  updateId: '43e04a7a-e7e1-4596-86d6-5c93e0d0d2f6',
  platform: 'ANDROID', runtimeVersion: '0.1.33', channel: 'prod',
  createdAt: new Date('2026-10-08T10:00:00Z'), rolloutPercent: 100,
  launchAssetKey: 'prod/bundle.hbc', launchAssetHash: 'bundle-hash',
  launchAssetType: 'application/javascript', assets: [{ key: 'prod/image.png', hash: 'image-hash' }],
  otaSequence: 1, displayVersion: '0.1.33.1', metadata,
});
const check = (runtime = '0.1.33') => request(app).get('/ota/update')
  .set('expo-platform', 'android').set('expo-runtime-version', runtime).set('expo-channel-name', 'prod')
  .buffer(true).parse((res, callback) => {
    let rawBody = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => { rawBody += chunk; });
    res.on('end', () => callback(null, { rawBody }));
  });
function parseManifest(response: request.Response) {
  const part = response.body.rawBody.split('\r\n\r\n')[1].split('\r\n--')[0];
  return JSON.parse(part);
}

beforeEach(() => {
  jest.clearAllMocks();
  findMany.mockResolvedValue([]);
  findUnique.mockResolvedValue(null);
  aggregate.mockResolvedValue({ _max: { otaSequence: null }, _count: { _all: 0 } });
  upsert.mockImplementation(async ({ create }) => create);
});

test('serves the exact build config in extra.expoClient over the real HTTP route', async () => {
  findMany.mockResolvedValue([release({ expoClient: config, expoConfigSchemaVersion: 1, baseVersionCode: 32 })]);
  const res = await check();
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('multipart/mixed');
  const manifest = parseManifest(res);
  expect(manifest.extra.expoClient).toEqual(config);
  expect(manifest.metadata.expoClient).toBeUndefined();
  expect(manifest.metadata.displayVersion).toBe('0.1.33.1');
  expect(manifest.launchAsset.hash).toBe('bundle-hash');
  expect(manifest.assets).toHaveLength(1);
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { platform: 'ANDROID', channel: 'prod', runtimeVersion: '0.1.33', isActive: true },
  }));
});

test.each(['0.1.26', '0.1.33'])('repairs a legacy manifest for %s without changing bundle or runtime', async (runtimeVersion) => {
  const old = { ...release({ baseVersionCode: 25 }), runtimeVersion };
  findMany.mockResolvedValue([old]);
  const manifest = parseManifest(await check(runtimeVersion));
  expect(manifest.extra.expoClient).toMatchObject({ scheme: 'leaderproduct', version: runtimeVersion,
    runtimeVersion, android: { package: 'com.leaderproduct.app', versionCode: 25 } });
  expect(manifest.id).toBe(old.updateId);
  expect(manifest.launchAsset.hash).toBe(old.launchAssetHash);
});

test('legacy fallback does not invent a native build number', () => {
  expect(resolveOtaExpoConfig(release()).android).toEqual({ package: 'com.leaderproduct.app' });
});

test('already installed update and unknown runtime still receive 204, with no storage requests', async () => {
  findMany.mockResolvedValue([release()]);
  expect((await check().set('expo-current-update-id', release().updateId)).status).toBe(204);
  findMany.mockResolvedValue([]);
  expect((await check('unknown')).status).toBe(204);
  expect(resolveUrl).not.toHaveBeenCalled();
});

test('does not send a broken new-style manifest or resolve its assets', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    findMany.mockResolvedValue([release({ expoClient: {}, expoConfigSchemaVersion: 1 })]);
    expect((await check()).status).toBe(204);
    expect(resolveUrl).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

test.each([{}, { expoClient: {} }, { expoClient: { ...config, scheme: '' } },
  { expoClient: { ...config, runtimeVersion: '0.1.26' } },
  { expoClient: { ...config, android: {} } },
])('HTTP publication rejects incomplete/incompatible config before writing', async (metadata) => {
  expect((await request(app).post('/ota/publish').send(release(metadata))).status).toBe(400);
  expect(upsert).not.toHaveBeenCalled();
  expect(aggregate).not.toHaveBeenCalled();
});

test('HTTP publication persists config along with the display version', async () => {
  const res = await request(app).post('/ota/publish').send(release({ expoClient: config, expoConfigSchemaVersion: 1 }));
  expect(res.status).toBe(201);
  expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({
    metadata: expect.objectContaining({ expoClient: config, displayVersion: '0.1.33.1' }),
  }) }));
});

test('accepts multiple registered schemes and validates iOS identity', () => {
  expect(validateOtaExpoConfig({ expoClient: { ...config, scheme: ['leaderproduct', 'com.leaderproduct.app'] } }, '0.1.33', 'IOS')).toBeTruthy();
  expect(() => validateOtaExpoConfig({ expoClient: { ...config, ios: {} } }, '0.1.33', 'IOS')).toThrow('bundleIdentifier');
});

test('direct DB publisher also rejects missing config even during dry run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-ota-test-'));
  const file = path.join(dir, 'metadata.json');
  try {
    fs.writeFileSync(file, JSON.stringify(release()));
    expect(() => execFileSync(process.execPath, ['scripts/publish-ota-update-db.js', file, '--dry-run'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test' },
      stdio: 'pipe', timeout: 20000,
    })).toThrow(/expoClient/);
    fs.writeFileSync(file, JSON.stringify(release({ expoClient: config })));
    const output = execFileSync(process.execPath, ['scripts/publish-ota-update-db.js', file, '--dry-run'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test' },
      encoding: 'utf8', stdio: 'pipe', timeout: 20000,
    });
    expect(output).toContain('Dry run: not writing database');
    expect(output).not.toContain('postgresql://');
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
