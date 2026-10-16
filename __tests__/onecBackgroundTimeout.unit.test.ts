import { getOnecLpAppWarehouses, withBackgroundOnecRequests } from '../src/modules/onec/onec.lpApp.client';
const originalFetch = global.fetch;
beforeEach(() => {
  process.env.ONEC_LP_APP_BASE_URL = 'http://onec.test/hs/lp-app';
  process.env.ONEC_LP_APP_API_KEY = 'qa-only';
  process.env.ONEC_LP_APP_BASIC_USER = 'qa'; process.env.ONEC_LP_APP_BASIC_PASSWORD = 'qa';
  delete process.env.ONEC_LP_APP_DIRECTORY_TIMEOUT_MS;
  delete process.env.ONEC_LP_APP_BACKGROUND_DIRECTORY_TIMEOUT_MS;
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });
it('gives slow 1C reference validation a worker budget without lengthening foreground requests', async () => {
  const timer = jest.spyOn(global, 'setTimeout');
  await Promise.all([withBackgroundOnecRequests(() => getOnecLpAppWarehouses({})), getOnecLpAppWarehouses({})]);
  expect(timer.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining([90_000, 30_000]));
});
it('does not leak the worker budget into subsequent foreground requests', async () => {
  await withBackgroundOnecRequests(() => getOnecLpAppWarehouses({}));
  const timer = jest.spyOn(global, 'setTimeout'); await getOnecLpAppWarehouses({});
  expect(timer.mock.calls.map(call => call[1])).toEqual([30_000]);
});
