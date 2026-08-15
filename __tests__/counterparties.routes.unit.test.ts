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
jest.mock('../src/modules/counterparties/counterparties.service', () => {
  const actual = jest.requireActual('../src/modules/counterparties/counterparties.service');
  return { ...actual, getCounterpartyCard: jest.fn() };
});

import router from '../src/modules/counterparties/counterparties.routes';
import { getCounterpartyCard } from '../src/modules/counterparties/counterparties.service';

const app = express();
app.use('/api/counterparties', router);

describe('counterparty card route', () => {
  it('validates guid before calling service', async () => {
    const response = await request(app).get('/api/counterparties/not-a-guid/card');
    expect(response.status).toBe(400);
    expect(getCounterpartyCard).not.toHaveBeenCalled();
  });

  it('passes authenticated user and organization context', async () => {
    jest.mocked(getCounterpartyCard).mockResolvedValueOnce({ identity: { name: 'Клиент' } } as any);
    const response = await request(app)
      .get('/api/counterparties/11111111-1111-4111-8111-111111111111/card')
      .query({
        organizationGuid: '22222222-2222-4222-8222-222222222222',
        preset: 'custom',
        periodFrom: '2026-07-01',
        periodTo: '2026-07-31',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.identity.name).toBe('Клиент');
    expect(getCounterpartyCard).toHaveBeenCalledWith(expect.objectContaining({
      counterpartyGuid: '11111111-1111-4111-8111-111111111111',
      organizationGuid: '22222222-2222-4222-8222-222222222222',
      preset: 'custom',
      periodFrom: '2026-07-01',
      periodTo: '2026-07-31',
      userId: 7,
      roleName: 'employee',
      permissionNames: ['view_client_orders'],
      forceRefresh: false,
    }));
  });

  it('rejects an incomplete or reversed custom period', async () => {
    const incomplete = await request(app)
      .get('/api/counterparties/11111111-1111-4111-8111-111111111111/card')
      .query({ preset: 'custom', periodFrom: '2026-07-01' });
    const reversed = await request(app)
      .get('/api/counterparties/11111111-1111-4111-8111-111111111111/card')
      .query({ preset: 'custom', periodFrom: '2026-08-01', periodTo: '2026-07-01' });

    expect(incomplete.status).toBe(400);
    expect(reversed.status).toBe(400);
  });

  it('never accepts managerGuid from the client', async () => {
    jest.mocked(getCounterpartyCard).mockResolvedValueOnce({ identity: { name: 'Клиент' } } as any);
    const response = await request(app)
      .get('/api/counterparties/11111111-1111-4111-8111-111111111111/card')
      .query({ managerGuid: '99999999-9999-4999-8999-999999999999' });

    expect(response.status).toBe(200);
    expect(getCounterpartyCard).toHaveBeenCalledWith(expect.not.objectContaining({ managerGuid: expect.anything() }));
    expect(getCounterpartyCard).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }));
  });
});
