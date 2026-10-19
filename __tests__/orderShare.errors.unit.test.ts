import { logShareError, presentShareError, ShareError, ShareProjectionError } from '../src/modules/orderShare/orderShare.errors';

it.each([403, 404, 409, 422, 502, 504])('maps source HTTP %i to a safe actionable error', status => {
  const result = presentShareError(Object.assign(new Error('private upstream URL and payload'), { status }));
  expect(result.message).not.toMatch(/private|upstream|payload/);
  expect(result.status).toBe(status === 502 || status === 504 ? 503 : status);
});

it('keeps validation, unavailable snapshot and ownership errors distinguishable', () => {
  expect(presentShareError(new ShareProjectionError('Заполните товары', 'ORDER_ITEMS_MISSING')))
    .toMatchObject({ status: 422, code: 'ORDER_ITEMS_MISSING' });
  expect(presentShareError(new ShareError(503, 'Попробуйте позже', 'ORDER_SNAPSHOT_UNAVAILABLE')))
    .toMatchObject({ status: 503, code: 'ORDER_SNAPSHOT_UNAVAILABLE' });
});

it('does not flood logs with expired or invalid public capabilities', () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    for (const operation of ['PUBLIC_READ', 'IMAGE_READ'] as const) {
      logShareError(new ShareError(410, 'Ссылка недоступна'), { operation });
    }
    expect(log).not.toHaveBeenCalled();
    logShareError(new ShareError(404, 'Заказ не найден'), { operation: 'CREATE' });
    expect(log).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); }
});

it('logs safe diagnostics but never error messages, capability URLs, arbitrary identifiers or credentials', () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const secret = 'sensitive-token-12';
    const error = Object.assign(new Error(`postgres://user:password@host https://api.example/order/${secret}`), {
      code: 'P2024', cause: { code: 'ECONNREFUSED' },
      stack: `Error: ${secret}\n    at generate (/app/dist/modules/orderShare/orderShare.service.js:42:10)\n    at https://api.example/order/${secret}`,
    });
    logShareError(error, { operation: 'CREATE', orderGuid: secret, requestId: secret, ownerId: 100 });
    expect(log).toHaveBeenCalledWith('[order-share] operation failed', expect.objectContaining({
      operation: 'CREATE', status: 503, errorCode: 'P2024', causeCode: 'ECONNREFUSED', ownerId: 100,
      frames: ['/app/dist/modules/orderShare/orderShare.service.js:42:10'],
    }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/sensitive-token|password|postgres:|api\.example/);
  } finally { log.mockRestore(); }
});
