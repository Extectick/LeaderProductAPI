import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 7, role: 'employee', permissions: ['view_client_orders'], profileStatus: 'ACTIVE' };
    next();
  },
  authorizePermissions: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/middleware/checkUserStatus', () => ({ checkUserStatus: (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/middleware/serviceAccess', () => ({ authorizeServiceAccess: () => (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/modules/catalog/catalog.service', () => {
  class CatalogError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return {
    CatalogError,
    getCatalogManifest: jest.fn(),
    getCatalogSnapshot: jest.fn(),
    getCatalogChanges: jest.fn(),
  };
});

import router from '../src/modules/catalog/catalog.routes';
import {
  CatalogError,
  getCatalogChanges,
  getCatalogManifest,
  getCatalogSnapshot,
} from '../src/modules/catalog/catalog.service';

const app = express();
app.use('/api/catalog', router);

describe('versioned catalog routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a stable ETag and supports conditional manifest reads', async () => {
    jest.mocked(getCatalogManifest).mockResolvedValue({
      epoch: 'epoch-1', schemaVersion: 1, revision: '42', minAvailableRevision: '10',
      productCount: 1250, lastSourceUpdateAt: null, lastFullReconcileAt: null,
      generatedAt: '2026-08-19T10:00:00.000Z',
    });
    const first = await request(app).get('/api/catalog/manifest');
    const second = await request(app).get('/api/catalog/manifest').set('If-None-Match', 'W/"catalog-epoch-1-42"');

    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe('W/"catalog-epoch-1-42"');
    expect(first.body.data.productCount).toBe(1250);
    expect(second.status).toBe(304);
  });

  it('validates and forwards keyset snapshot parameters', async () => {
    jest.mocked(getCatalogSnapshot).mockResolvedValue({
      epoch: 'epoch-1', schemaVersion: 1, snapshotRevision: '42', items: [], nextCursor: null, hasMore: false,
    });
    const response = await request(app).get('/api/catalog/snapshot').query({
      epoch: 'epoch-1', snapshotRevision: '42', cursor: 'product-guid', limit: 500,
    });

    expect(response.status).toBe(200);
    expect(getCatalogSnapshot).toHaveBeenCalledWith({
      epoch: 'epoch-1', snapshotRevision: '42', cursor: 'product-guid', limit: 500,
    });
  });

  it('rejects invalid revisions before calling the service', async () => {
    const response = await request(app).get('/api/catalog/changes').query({ afterRevision: '-1' });
    expect(response.status).toBe(400);
    expect(getCatalogChanges).not.toHaveBeenCalled();
  });

  it('maps an expired delta history to HTTP 409', async () => {
    jest.mocked(getCatalogChanges).mockRejectedValueOnce(new CatalogError(409, 'Требуется полная синхронизация'));
    const response = await request(app).get('/api/catalog/changes').query({ afterRevision: '1', epoch: 'old' });
    expect(response.status).toBe(409);
    expect(response.body.message).toContain('полная синхронизация');
  });
});
