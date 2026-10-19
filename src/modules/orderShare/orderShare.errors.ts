export class ShareError extends Error {
  constructor(public status: number, message: string, public code = 'ORDER_SHARE_ERROR') {
    super(message);
    this.name = 'ShareError';
  }
}

export class ShareProjectionError extends ShareError {
  constructor(message: string, code: string) {
    super(422, message, code);
    this.name = 'ShareProjectionError';
  }
}

export type ShareOperation = 'CREATE' | 'MANAGER_READ' | 'REVOKE' | 'PUBLIC_READ' | 'IMAGE_READ' | 'REFRESH';
type DiagnosticContext = { operation: ShareOperation; requestId?: string; orderGuid?: string; ownerId?: number };

export function presentShareError(error: unknown) {
  if (error instanceof ShareError) return { status: error.status, message: error.message, code: error.code };
  const status = Number((error as { status?: number } | null)?.status);
  if (status === 403 || status === 404) return { status, message: 'Заказ недоступен.', code: 'ORDER_UNAVAILABLE' };
  if (status === 409) return { status, message: 'Заказ изменился. Обновите документ и повторите создание ссылки.', code: 'ORDER_CHANGED' };
  if (status === 400 || status === 422) return { status: 422, message: 'Проверьте заполнение заказа перед созданием ссылки.', code: 'ORDER_INVALID' };
  return { status: 503, message: 'Не удалось загрузить заказ. Попробуйте ещё раз.', code: 'ORDER_SHARE_UNAVAILABLE' };
}

/** Never serialize exceptions, URLs, headers, tokens, SQL parameters or order DTOs. */
export function logShareError(error: unknown, context: DiagnosticContext) {
  const response = presentShareError(error);
  // Expired/invalid public capabilities are expected and must not bury actual
  // creation failures (or allow anonymous visitors to amplify error logs).
  if ((context.operation === 'PUBLIC_READ' || context.operation === 'IMAGE_READ')
    && [403, 404, 410].includes(response.status)) return;
  const e = error as { name?: unknown; code?: unknown; stack?: unknown; cause?: { code?: unknown } } | null;
  const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined;
  const safeUuid = (value?: string) => value && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ? value : undefined;
  const frames = typeof e?.stack === 'string' ? e.stack.split('\n').slice(1)
    .filter(line => /^\s+at /.test(line))
    .map(line => line.match(/(?:\/app)?\/(?:src|dist)\/modules\/[A-Za-z0-9_./-]+\.[jt]s:\d+:\d+/)?.[0])
    .filter((frame): frame is string => !!frame).slice(0, 5) : [];
  const record = {
    operation: context.operation, requestId: safeUuid(context.requestId), orderGuid: safeUuid(context.orderGuid),
    ownerId: Number.isSafeInteger(context.ownerId) && context.ownerId! > 0 ? context.ownerId : undefined,
    status: response.status, code: response.code,
    errorType: typeof e?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : 'Error',
    errorCode: safeCode(e?.code), causeCode: safeCode(e?.cause?.code), frames,
    // Unknown exception messages are never logged, only bounded classifications.
    reason: error instanceof ShareError ? response.code : 'UNEXPECTED_FAILURE',
  };
  if (response.status >= 500) console.error('[order-share] operation failed', record);
  else console.warn('[order-share] operation rejected', record);
}
