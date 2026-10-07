import express from 'express';
import request from 'supertest';
jest.mock('../src/lib/kafka', () => ({ enqueueKafkaMessage: jest.fn(), getKafkaTopic: () => 'test', isKafkaEnabled: () => true }));
import { enqueueKafkaMessage } from '../src/lib/kafka';
import { kafkaRequestLogger } from '../src/middleware/kafkaRequestLogger';
it('keeps native and bootstrap credentials out of Kafka request/response logs', async () => {
  const app = express(); app.use(express.json()); app.use(kafkaRequestLogger);
  app.post('/tracking/native/commands', (_req, res) => res.json({ command: null }));
  app.get('/tracking/native/osmand', (_req, res) => res.send('ok'));
  app.post('/tracking/device/bootstrap', (_req, res) => res.json({ credential: 'lpt_RESPONSE_SECRET' }));
  await request(app).post('/tracking/native/commands').send({ credential: 'lpt_SECRET' });
  await request(app).get('/tracking/native/osmand?id=lpt_QUERY_SECRET&lat=55');
  await request(app).post('/tracking/device/bootstrap').send({ credential: 'lpt_SECRET' });
  const logs = JSON.stringify((enqueueKafkaMessage as jest.Mock).mock.calls);
  expect(logs).not.toContain('lpt_');
  expect(logs).toContain('[redacted]');
  expect((enqueueKafkaMessage as jest.Mock).mock.calls[0][0].status).toBe(200);
});
