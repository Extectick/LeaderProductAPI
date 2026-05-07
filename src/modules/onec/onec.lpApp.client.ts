export type OnecLpAppQuery = Record<string, string | number | boolean | null | undefined>;

export class OnecLpAppHttpError extends Error {
  constructor(
    public readonly upstreamStatus: number,
    public readonly payload: unknown,
    message: string
  ) {
    super(message);
    this.name = 'OnecLpAppHttpError';
  }
}

export class OnecLpAppNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnecLpAppNetworkError';
  }
}

export class OnecLpAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnecLpAppConfigError';
  }
}

type RouteOrderBody = {
  driverGuid?: string;
  driverUserGuid?: string;
  driverPhysicalPersonGuid?: string;
  route: Array<{ linkKey: string; order: number }>;
};

const DEFAULT_TIMEOUT_MS = 15_000;

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new OnecLpAppConfigError(`${name} is not configured`);
  }
  return value;
}

function getApiKey() {
  return getRequiredEnv('ONEC_LP_APP_API_KEY');
}

function getTimeoutMs() {
  const raw = Number(process.env.ONEC_LP_APP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_TIMEOUT_MS;
}

function buildUrl(path: string, query?: OnecLpAppQuery) {
  const baseUrl = getRequiredEnv('ONEC_LP_APP_BASE_URL').replace(/\/+$/, '');
  const normalizedPath = path.replace(/^\/+/, '');
  const url = new URL(`${baseUrl}/${normalizedPath}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  url.searchParams.set('apiKey', getApiKey());

  return url;
}

function buildHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-API-Key': getApiKey(),
  };

  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }

  const basicUser = process.env.ONEC_LP_APP_BASIC_USER?.trim();
  const basicPassword = process.env.ONEC_LP_APP_BASIC_PASSWORD ?? '';
  if (basicUser) {
    headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPassword}`, 'utf8').toString('base64')}`;
  }

  return headers;
}

function extractUpstreamMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object') {
    const maybeError = (payload as { error?: unknown }).error;
    if (typeof maybeError === 'string' && maybeError.trim()) return maybeError;
    const maybeMessage = (payload as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) return maybeMessage;
  }
  return fallback;
}

async function readResponsePayload(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function callOnecLpApp(path: string, options: { method?: string; query?: OnecLpAppQuery; body?: unknown } = {}) {
  const method = options.method ?? 'GET';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const response = await fetch(buildUrl(path, options.query), {
      method,
      headers: buildHeaders(options.body !== undefined),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw new OnecLpAppHttpError(
        response.status,
        payload,
        extractUpstreamMessage(payload, `1C responded with HTTP ${response.status}`)
      );
    }

    return payload;
  } catch (error: unknown) {
    if (error instanceof OnecLpAppHttpError || error instanceof OnecLpAppConfigError) {
      throw error;
    }

    const message =
      error instanceof Error && error.name === 'AbortError'
        ? '1C request timed out'
        : error instanceof Error
          ? error.message
          : '1C request failed';
    throw new OnecLpAppNetworkError(message);
  } finally {
    clearTimeout(timeout);
  }
}

export function pingOnecLpApp() {
  return callOnecLpApp('/ping');
}

export function getOnecLpAppUsers() {
  return callOnecLpApp('/users');
}

export function getOnecLpAppTransportTasks(query: OnecLpAppQuery) {
  return callOnecLpApp('/transport-tasks', { query });
}

export function getOnecLpAppTransportTask(taskGuid: string, query: OnecLpAppQuery) {
  return callOnecLpApp(`/transport-tasks/${encodeURIComponent(taskGuid)}`, { query });
}

export function postOnecLpAppRouteOrder(taskGuid: string, body: RouteOrderBody) {
  return callOnecLpApp(`/transport-tasks/${encodeURIComponent(taskGuid)}/route-order`, {
    method: 'POST',
    body,
  });
}

export function postOnecLpAppTransportTaskToLoading(taskGuid: string, body: RouteOrderBody) {
  return callOnecLpApp(`/transport-tasks/${encodeURIComponent(taskGuid)}/to-loading`, {
    method: 'POST',
    body,
  });
}
