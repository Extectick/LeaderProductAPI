import { createHash } from 'node:crypto';
import { cacheGet, cacheSet } from '../../lib/redis';

type CacheLoader<T> = () => Promise<T>;

const pendingReads = new Map<string, Promise<unknown>>();
const memoryCircuit = new Map<string, number>();
const memoryReads = new Map<string, { value: unknown; freshUntil: number; staleUntil: number }>();
const CACHE_PREFIX = 'client-orders';
const CIRCUIT_SCOPE = 'onec-live';
const MAX_MEMORY_CACHE_ENTRIES = 750;

export class ClientOrdersOnecCircuitOpenError extends Error {
  constructor() {
    super('Client orders 1C circuit is open');
    this.name = 'ClientOrdersOnecCircuitOpenError';
  }
}

export const CLIENT_ORDERS_CACHE_TTL = {
  ordersList: 20,
  orderDetail: 30,
  defaults: 120,
  counterparties: 180,
  agreements: 120,
  contracts: 120,
  deliveryAddresses: 180,
  warehouses: 600,
  priceTypes: 600,
  products: 45,
  productsBatch: 45,
  referenceData: 120,
  referenceDetails: 300,
};

function cacheEnabled() {
  return process.env.CLIENT_ORDERS_CACHE_DISABLE !== '1';
}

function onecCircuitTtlSeconds() {
  const raw = Number(process.env.CLIENT_ORDERS_ONEC_CIRCUIT_TTL_SEC);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 20;
}

function stableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && item !== null && item !== '')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

export function clientOrdersCacheKey(scope: string, payload: unknown) {
  const json = JSON.stringify(stableValue(payload));
  const hash = createHash('sha1').update(json).digest('hex');
  return `${CACHE_PREFIX}:${scope}:${hash}`;
}

function getMemoryValue<T>(key: string, mode: 'fresh' | 'stale' = 'fresh'): T | null {
  const entry = memoryReads.get(key);
  if (!entry) return null;
  const now = Date.now();
  const expiresAt = mode === 'fresh' ? entry.freshUntil : entry.staleUntil;
  if (expiresAt <= now) {
    memoryReads.delete(key);
    return null;
  }
  return entry.value as T;
}

function rememberMemoryValue(key: string, value: unknown, ttlSeconds: number) {
  if (memoryReads.size >= MAX_MEMORY_CACHE_ENTRIES) {
    const firstKey = memoryReads.keys().next().value;
    if (firstKey) memoryReads.delete(firstKey);
  }
  const now = Date.now();
  const ttlMs = ttlSeconds * 1000;
  memoryReads.set(key, {
    value,
    freshUntil: now + ttlMs,
    staleUntil: now + Math.max(ttlMs * 3, ttlMs + 60_000),
  });
}

export async function readThroughClientOrdersCache<T>(
  scope: string,
  payload: unknown,
  ttlSeconds: number,
  loader: CacheLoader<T>
): Promise<T> {
  if (!cacheEnabled() || ttlSeconds <= 0) return loader();

  const key = clientOrdersCacheKey(scope, payload);
  const memoryFresh = getMemoryValue<T>(key, 'fresh');
  if (memoryFresh !== null) return memoryFresh;

  try {
    const cached = await cacheGet<T>(key);
    if (cached !== null) {
      rememberMemoryValue(key, cached, ttlSeconds);
      return cached;
    }
  } catch {
    // Redis cache is best-effort; live read remains the source of truth.
  }

  if (await isClientOrdersOnecCircuitOpen()) {
    const memoryStale = getMemoryValue<T>(key, 'stale');
    if (memoryStale !== null) return memoryStale;
    throw new ClientOrdersOnecCircuitOpenError();
  }

  const pending = pendingReads.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const task = loader()
    .then(async (value) => {
      rememberMemoryValue(key, value, ttlSeconds);
      try {
        await cacheSet(key, value, ttlSeconds);
      } catch {
        // Ignore cache write failures.
      }
      return value;
    })
    .finally(() => {
      pendingReads.delete(key);
    });

  pendingReads.set(key, task);
  return task;
}

function circuitKey(scope = CIRCUIT_SCOPE) {
  return `${CACHE_PREFIX}:circuit:${scope}`;
}

export async function isClientOrdersOnecCircuitOpen(scope = CIRCUIT_SCOPE) {
  const key = circuitKey(scope);
  const now = Date.now();
  const memoryUntil = memoryCircuit.get(key) ?? 0;
  if (memoryUntil > now) return true;
  if (memoryUntil) memoryCircuit.delete(key);

  if (!cacheEnabled()) return false;

  try {
    return Boolean(await cacheGet<{ until: number }>(key));
  } catch {
    return false;
  }
}

export async function markClientOrdersOnecCircuitOpen(scope = CIRCUIT_SCOPE) {
  const ttl = onecCircuitTtlSeconds();
  const until = Date.now() + ttl * 1000;
  const key = circuitKey(scope);
  memoryCircuit.set(key, until);

  if (!cacheEnabled()) return;

  try {
    await cacheSet(key, { until }, ttl);
  } catch {
    // Memory circuit still protects this process.
  }
}

export function clearClientOrdersOnecCircuit(scope = CIRCUIT_SCOPE) {
  memoryCircuit.delete(circuitKey(scope));
}
