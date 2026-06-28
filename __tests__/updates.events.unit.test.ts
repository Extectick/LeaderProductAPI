import express from 'express';
import request from 'supertest';
import updatesRouter from '../src/routes/updates';

const createMock = jest.fn();

jest.mock('../src/prisma/client', () => ({
  __esModule: true,
  default: {
    appUpdateEvent: {
      create: (...args: unknown[]) => createMock(...args),
    },
  },
}));

jest.mock('../src/storage/minio', () => ({
  buildFileAccessUrl: jest.fn(),
  buildObjectKey: jest.fn(),
  deleteObject: jest.fn(),
  presignGet: jest.fn(),
  presignPut: jest.fn(),
  resolveObjectUrl: jest.fn(),
  uploadMulterFile: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/updates', updatesRouter);

describe('updates events route', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ id: 101 });
  });

  it('accepts APK and OTA update lifecycle events', async () => {
    for (const eventType of ['DOWNLOAD_START', 'DOWNLOAD_DONE', 'VERIFY_FAILED', 'INSTALL_CLICK', 'OTA_READY', 'OTA_RELOAD']) {
      const res = await request(app)
        .post('/updates/events')
        .send({
          eventType,
          platform: 'android',
          channel: 'dev',
          versionCode: 16,
          versionName: '0.1.17',
          deviceId: 'device-1',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(101);
      expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          eventType,
          platform: 'ANDROID',
          channel: 'dev',
          versionCode: 16,
        }),
      }));
    }
  });

  it('rejects unknown update event types', async () => {
    const res = await request(app)
      .post('/updates/events')
      .send({
        eventType: 'BAD_EVENT',
        platform: 'android',
        versionCode: 16,
      });

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });
});
