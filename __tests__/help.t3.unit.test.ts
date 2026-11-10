jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { helpAssistantJob: { findUnique: jest.fn() }, $transaction: jest.fn() } }));
jest.mock('../src/lib/redis', () => ({ getRedis: jest.fn(), connectRedis: jest.fn() }));
jest.mock('../src/modules/help/help.service', () => ({ helpActor: jest.fn() }));
jest.mock('../src/modules/help/help.knowledge', () => ({ validateHelpKnowledgeSources: jest.fn() }));
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import supertest from 'supertest';
import prisma from '../src/prisma/client';
import { connectRedis, getRedis } from '../src/lib/redis';
import { helpActor } from '../src/modules/help/help.service';
import { validateHelpKnowledgeSources } from '../src/modules/help/help.knowledge';
import t3Router from '../src/modules/help/help.t3.routes';
import { authorizeT3Request, completeT3Request, requestT3Answer, t3Configuration, validateT3Result, type T3Context, type T3Store } from '../src/modules/help/help.t3-exchange';
import { buildT3Context } from '../src/modules/help/help.t3';

const original = { ...process.env };
const folder = mkdtempSync(join(tmpdir(), 'leader-t3-unit-'));
const urlFile = join(folder, 'webhook');
const job = { id: 'job1', ticketId: 3, ownerId: 7, leaseToken: 'lease1' };
const context: T3Context = { messages: [{ role: 'user', text: 'Не работает принтер' }], sources: [] };
const answer = { decision: 'clarify', message: 'Какая модель принтера?', source_ids: [] };
let values: Map<string, string>;
let store: T3Store;
let transport: jest.Mock;
let payload: { requestId: string; capability: string; version: number };
let live: any;
const app = express().use('/help/t3/requests', t3Router);
beforeEach(() => {
  process.env = { ...original, NODE_ENV: 'development', HELP_AI_ENABLED: 'true', HELP_AI_PROVIDER: 't3', HELP_T3_DEV_ENABLED: 'true', HELP_T3_WEBHOOK_URL_FILE: urlFile };
  writeFileSync(urlFile, 'https://t3.example/secret-webhook');
  jest.clearAllMocks();
  values = new Map();
  store = {
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, options: any) => {
      if (options?.NX && values.has(key)) return null;
      values.set(key, value); return 'OK';
    }),
    del: jest.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); return 1; }),
  } as unknown as T3Store;
  (getRedis as jest.Mock).mockReturnValue(store);
  (connectRedis as jest.Mock).mockResolvedValue(store);
  live = { ...job, provider: 't3', status: 'RUNNING', leaseUntil: new Date(Date.now() + 90000), ticket: { status: 'OPEN', itRequested: false, members: [] } };
  (prisma.helpAssistantJob.findUnique as jest.Mock).mockImplementation(async () => live);
  (prisma.$transaction as jest.Mock).mockImplementation(async work => work({}));
  (helpActor as jest.Mock).mockResolvedValue({ userId: 7 });
  (validateHelpKnowledgeSources as jest.Mock).mockResolvedValue(undefined);
  transport = jest.fn(async (_url, init) => { payload = JSON.parse(init.body); return new Response(null, { status: 202 }); });
});
afterAll(() => { process.env = original; rmSync(folder, { recursive: true }); });

const exchange = (signal = new AbortController().signal, wait?: (signal: AbortSignal) => Promise<unknown>) =>
  requestT3Answer(job, context, [], signal, transport, store, wait);

test.each([
  { NODE_ENV: 'production' }, { HELP_T3_DEV_ENABLED: 'false' }, { HELP_AI_ENABLED: 'false' },
  { HELP_AI_PROVIDER: 'bunny' }, { HELP_T3_WEBHOOK_URL_FILE: '' },
])('does not dispatch without all opt-ins: %j', async change => {
  Object.assign(process.env, change);
  await expect(exchange()).rejects.toMatchObject({ code: 'HELP_T3_NOT_CONFIGURED' });
  expect(transport).not.toHaveBeenCalled(); expect(store.set).not.toHaveBeenCalled();
});
test('no employee data or operational credentials go into webhook; callback publishes only the first valid result', async () => {
  const result = await exchange(undefined, async () => {
    expect(payload).toEqual({ version: 1, requestId: expect.any(String), capability: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(transport.mock.calls[0][1].redirect).toBe('error');
    expect(transport.mock.calls[0][1].body).not.toContain(context.messages[0].text);
    expect([...values.values()].join('')).not.toContain(payload.capability);
    const response = await supertest(app).get(`/help/t3/requests/${payload.requestId}`).set('Authorization', `Bearer ${payload.capability}`).expect(200);
    expect(response.body).toEqual(context); expect(response.headers['cache-control']).toBe('private, no-store');
    await supertest(app).post(`/help/t3/requests/${payload.requestId}/result`).set('Authorization', `Bearer ${payload.capability}`).send(answer).expect(202);
    await supertest(app).post(`/help/t3/requests/${payload.requestId}/result`).set('Authorization', `Bearer ${payload.capability}`).send({ ...answer, message: 'replacement' }).expect(409);
  });
  expect(result).toMatchObject({ ...answer, responseId: payload.requestId }); expect(values.size).toBe(0);
});
test.each(['wrong-token', 'missing', 'expired-lease', 'superseded', 'changed-lease', 'handoff', 'closed', 'other-provider', 'other-owner', 'other-ticket', 'IT-member', 'revoked-actor', 'revoked-sources'])('rejects unavailable context and callback: %s', async kind => {
  const controller = new AbortController();
  await expect(exchange(controller.signal, async () => {
    let token = payload.capability;
    if (kind === 'wrong-token') token = 'f'.repeat(64);
    if (kind === 'missing') values.clear();
    if (kind === 'expired-lease') live.leaseUntil = new Date(0);
    if (kind === 'superseded') live.status = 'SUPERSEDED';
    if (kind === 'changed-lease') live.leaseToken = 'replacement';
    if (kind === 'handoff') live.ticket.itRequested = true;
    if (kind === 'closed') live.ticket.status = 'CLOSED';
    if (kind === 'other-provider') live.provider = 'bunny';
    if (kind === 'other-owner') live.ownerId = 8;
    if (kind === 'other-ticket') live.ticketId = 4;
    if (kind === 'IT-member') live.ticket.members = [{ role: 'IT' }];
    if (kind === 'revoked-actor') (helpActor as jest.Mock).mockRejectedValue(new Error('denied'));
    if (kind === 'revoked-sources') (validateHelpKnowledgeSources as jest.Mock).mockRejectedValue(new Error('changed'));
    await expect(authorizeT3Request(payload.requestId, token, store)).rejects.toBeDefined();
    await expect(completeT3Request(payload.requestId, token, answer, store)).rejects.toBeDefined();
    controller.abort();
  })).rejects.toMatchObject({ code: 'HELP_T3_CANCELLED' });
  expect(values.size).toBe(0);
});
test('disabled route returns 404 without Redis or database access', async () => {
  process.env.HELP_AI_PROVIDER = 'bunny';
  await supertest(app).get('/help/t3/requests/550e8400-e29b-41d4-a716-446655440000').expect(404);
  expect(prisma.helpAssistantJob.findUnique).not.toHaveBeenCalled(); expect(getRedis).not.toHaveBeenCalled();
});
test('rejects missing capabilities, invalid JSON and oversized body before global loggers', async () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  await supertest(app).get(`/help/t3/requests/${id}`).expect(404);
  await supertest(app).post(`/help/t3/requests/${id}/result`).set('Content-Type', 'application/json').send('{secret').expect(400, { code: 'HELP_T3_INVALID_REQUEST' });
  await supertest(app).post(`/help/t3/requests/${id}/result`).send({ private: 'a'.repeat(70000) }).expect(413);
  expect(prisma.helpAssistantJob.findUnique).not.toHaveBeenCalled();
});
test('rejects invented citations and incomplete structured results', () => {
  expect(() => validateT3Result({ ...answer, source_ids: ['S2'] }, context)).toThrow('HELP_T3_INVALID_CITATIONS');
  expect(() => validateT3Result({ ...answer, reasoning: 'private' }, context)).toThrow('HELP_T3_INVALID_RESPONSE');
  expect(() => validateT3Result({ ...answer, message: '' }, context)).toThrow('HELP_T3_INVALID_RESPONSE');
  const grounded = { ...context, sources: [{ id: 'S1', title: 'Printer', revision: 1, excerpt: 'Text' }] };
  expect(() => validateT3Result({ ...answer, decision: 'answer' }, grounded)).toThrow('HELP_T3_INVALID_CITATIONS');
  expect(validateT3Result({ ...answer, decision: 'answer', source_ids: ['S1'] }, grounded).source_ids).toEqual(['S1']);
});
test.each([400, 401, 429, 503])('HTTP %s never leaks the webhook URL or upstream body and always removes the exchange', async status => {
  transport.mockResolvedValue(new Response('private upstream body', { status }));
  const error = await exchange().catch(error => error);
  expect(error).toMatchObject({ code: `HELP_T3_HTTP_${status}`, retryable: status === 429 || status >= 500 });
  expect(String(error)).not.toMatch(/secret-webhook|private upstream/); expect(values.size).toBe(0);
});
test('cancellation reaches the in-flight webhook and removes access', async () => {
  const controller = new AbortController();
  transport.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('secret-webhook'))); controller.abort();
  }));
  await expect(exchange(controller.signal)).rejects.toMatchObject({ code: 'HELP_T3_CANCELLED', retryable: true });
  expect(values.size).toBe(0);
});
test.each(['http://t3.example/webhook', 'https://user:password@t3.example/webhook', 'not-url'])('refuses invalid or insecure webhook URL %s', async url => {
  writeFileSync(urlFile, url);
  await expect(exchange()).rejects.toMatchObject({ code: 'HELP_T3_NOT_CONFIGURED' }); expect(transport).not.toHaveBeenCalled();
});
test('configuration remains a development-only preparation', () => {
  expect(t3Configuration()).toMatchObject({ enabled: true, timeoutMs: 300000, maxAttempts: 2 });
});
test('limits messages and excerpts, strips source paths and preserves the latest user question', () => {
  const sources = Array.from({ length: 8 }, () => ({ documentId: 'd', versionId: 'v', revision: 1,
    title: 'Doc', path: '/private', sourceUrl: 'https://private.example', excerpt: 'x'.repeat(4000) }));
  const history = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, text: `${i}:` + 'a'.repeat(3000) }));
  history.push({ role: 'user', text: 'Актуальный вопрос' });
  const bounded = buildT3Context(history, sources);
  expect(bounded.messages.length).toBeLessThanOrEqual(16);
  expect(bounded.messages.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(6000);
  expect(bounded.messages[bounded.messages.length - 1]?.text).toBe('Актуальный вопрос');
  expect(bounded.sources).toHaveLength(3);
  expect(bounded.sources.reduce((sum, source) => sum + source.excerpt.length, 0)).toBeLessThanOrEqual(9500);
  expect(JSON.stringify(bounded)).not.toMatch(/private|documentId|versionId/);
});

test('a dedicated worker can deliver a T3 answer with Redis initially disconnected', async () => {
  let connected = false;
  const set = (store.set as jest.Mock).getMockImplementation()!;
  (store.set as jest.Mock).mockImplementation(async (...args: unknown[]) => {
    if (!connected) throw new Error('The client is closed');
    return set(...args);
  });
  (connectRedis as jest.Mock).mockImplementation(async () => { connected = true; return store; });
  const result = await requestT3Answer(job, context, [], new AbortController().signal, transport, undefined, async () => {
    await completeT3Request(payload.requestId, payload.capability, answer, store);
  });
  expect(result).toMatchObject({ ...answer, responseId: payload.requestId });
  expect(values.size).toBe(0);
});
