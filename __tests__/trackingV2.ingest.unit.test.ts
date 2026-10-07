import express from 'express';
import request from 'supertest';

const mockPrisma = {
  trackingDeviceToken: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  routePoint: {
    findUnique: jest.fn(),
  },
  trackingLocationRequest: {
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.mock('../src/prisma/client', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../src/services/pushService', () => ({
  sendPushToUser: jest.fn(),
}));

jest.mock('../src/middleware/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import trackingV2Router from '../src/routes/trackingV2';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/tracking', trackingV2Router);

const activeToken = {
  id: 37,
  userId: 7,
  revokedAt: null,
  trackingEnabled: true,
  user: { id: 7, isActive: true, profileStatus: 'ACTIVE' },
};

describe('/tracking/native/osmand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.trackingDeviceToken.findUnique.mockResolvedValue(activeToken);
    mockPrisma.trackingDeviceToken.update.mockResolvedValue(activeToken);
    mockPrisma.trackingLocationRequest.updateMany.mockResolvedValue({ count: 0 });
  });

  it('accepts a coordinate-less Traccar heartbeat and refreshes device liveness', async () => {
    const response = await request(app)
      .post('/tracking/native/osmand')
      .type('form')
      .send({ id: 'lpt_valid', timestamp: Math.floor(Date.now() / 1000) });

    expect(response.status).toBe(200);
    expect(response.text).toBe('heartbeat');
    expect(mockPrisma.trackingDeviceToken.update).toHaveBeenCalledWith({
      where: { id: activeToken.id },
      data: { lastUsedAt: expect.any(Date) },
    });
    expect(mockPrisma.routePoint.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not interpret blank coordinates as a valid zero-zero route point', async () => {
    const response = await request(app)
      .post('/tracking/native/osmand')
      .type('form')
      .send({ id: 'lpt_valid', lat: '', lon: '', timestamp: Math.floor(Date.now() / 1000) });

    expect(response.status).toBe(200);
    expect(response.text).toBe('heartbeat');
    expect(mockPrisma.routePoint.findUnique).not.toHaveBeenCalled();
  });

  it('drains a permanently malformed point but still records device liveness', async () => {
    const response = await request(app)
      .post('/tracking/native/osmand')
      .type('form')
      .send({ id: 'lpt_valid', lat: '55.03', timestamp: Math.floor(Date.now() / 1000) });

    expect(response.status).toBe(202);
    expect(response.text).toBe('ignored invalid point');
    expect(mockPrisma.trackingDeviceToken.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.routePoint.findUnique).not.toHaveBeenCalled();
  });

  it('drains points for a deliberately disabled device without marking it active', async () => {
    mockPrisma.trackingDeviceToken.findUnique.mockResolvedValue({
      ...activeToken,
      trackingEnabled: false,
    });

    const response = await request(app)
      .post('/tracking/native/osmand')
      .type('form')
      .send({ id: 'lpt_valid', timestamp: Math.floor(Date.now() / 1000) });

    expect(response.status).toBe(202);
    expect(response.text).toBe('device disabled');
    expect(mockPrisma.trackingDeviceToken.update).not.toHaveBeenCalled();
  });
});
