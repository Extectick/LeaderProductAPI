import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
jest.mock('../src/modules/onec-personal/service', () => ({ listOnecConnections: jest.fn(), connectOnec: jest.fn(), disconnectOnec: jest.fn() }));
import router from '../src/modules/onec-personal/routes';
import { connectOnec, listOnecConnections } from '../src/modules/onec-personal/service';
const app = express(), leaked = jest.fn();
app.use('/users/me/onec-connections', router);
app.use(express.json(), (req, res) => { leaked(req.body); res.sendStatus(404); });
const token = jwt.sign({ userId: 42, role: 'employee' }, process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret');
beforeEach(() => { jest.clearAllMocks(); (connectOnec as jest.Mock).mockResolvedValue({ connected: true }); (listOnecConnections as jest.Mock).mockResolvedValue([]); });
test('credentials are scoped to JWT user and response is not cacheable', async () => {
  const r = await request(app).put('/users/me/onec-connections/test').auth(token, { type: 'bearer' }).send({ login: 'alice', password: 'secret' });
  expect(r.status).toBe(200); expect(r.headers['cache-control']).toBe('no-store');
  expect(connectOnec).toHaveBeenCalledWith(42, 'test', 'alice', 'secret'); expect(r.text).not.toContain('secret'); expect(leaked).not.toHaveBeenCalled();
});
test('cannot select another app user, pass arbitrary URL, or expose malformed/unknown-method bodies to loggers', async () => {
  for (const body of [{ userId: 100, login: 'alice', password: 'secret' }, { url: 'http://attacker', password: 'secret' }]) {
    expect((await request(app).put('/users/me/onec-connections/test').auth(token, { type: 'bearer' }).send(body)).status).toBe(400);
  }
  const malformed = await request(app).put('/users/me/onec-connections/test').auth(token, { type: 'bearer' }).set('Content-Type', 'application/json').send('{"password":"secret"BROKEN');
  expect(malformed.status).toBe(400); expect(malformed.text).not.toContain('secret');
  expect((await request(app).patch('/users/me/onec-connections/test').auth(token, { type: 'bearer' }).send({ password: 'secret' })).status).toBe(405);
  expect(connectOnec).not.toHaveBeenCalled(); expect(leaked).not.toHaveBeenCalled();
});
