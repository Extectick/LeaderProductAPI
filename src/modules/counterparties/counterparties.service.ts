import { createHash } from 'node:crypto';
import { cacheGet, cacheSet } from '../../lib/redis';
import { ErrorCodes } from '../../utils/apiResponse';
import {
  getOnecLpAppCounterpartyCard,
  OnecLpAppHttpError,
  type OnecLpAppQuery,
} from '../onec/onec.lpApp.client';
import { mapOnecCounterpartyCard } from './counterparties.mapper';
import type {
  CounterpartyCardBootstrap,
  CounterpartyCardPeriods,
  CounterpartyCardPermissions,
  CounterpartyPeriodPreset,
} from './counterparties.types';

type CacheEntry = {
  value: CounterpartyCardBootstrap;
  fetchedAt: string;
};

export class CounterpartiesError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCodes,
    message: string
  ) {
    super(message);
    this.name = 'CounterpartiesError';
  }
}

// Bump this value whenever API-side scoping changes. It prevents an older,
// broader cached projection from being returned under newer access rules.
const CARD_CONTRACT_VERSION = 'counterparty-card-api-v14';
// Financial and sales aggregates are expensive in 1C and do not need
// second-by-second freshness. Explicit pull-to-refresh bypasses this cache.
const CARD_FRESH_TTL_SECONDS = 2 * 60;
const CARD_STALE_TTL_SECONDS = 30 * 60;
const MAX_MEMORY_ENTRIES = 500;
const TIME_ZONE = 'Asia/Omsk';
const pendingReads = new Map<string, Promise<CounterpartyCardBootstrap>>();
const memoryCache = new Map<string, { entry: CacheEntry; expiresAt: number }>();

function dayParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')) };
}

function isoDay(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function utcDay(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatDay(value: Date) {
  return isoDay(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftMonthsCapped(date: Date, months: number) {
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth() + months;
  const targetFirst = new Date(Date.UTC(year, monthIndex, 1));
  const targetYear = targetFirst.getUTCFullYear();
  const targetMonth = targetFirst.getUTCMonth() + 1;
  return utcDay(targetYear, targetMonth, Math.min(date.getUTCDate(), daysInMonth(targetYear, targetMonth)));
}

function firstDayOfMonth(year: number, month: number) {
  return utcDay(year, month, 1);
}

function lastDayOfMonth(year: number, month: number) {
  return utcDay(year, month, daysInMonth(year, month));
}

export function counterpartyCardPeriods(
  now = new Date(),
  preset: CounterpartyPeriodPreset = 'month',
  custom?: { periodFrom?: string; periodTo?: string }
): CounterpartyCardPeriods {
  const { year, month, day } = dayParts(now);
  let currentEnd = utcDay(year, month, day);
  let currentStart: Date;
  let compareStart: Date;
  let compareEnd: Date;

  if (preset === 'custom') {
    if (!custom?.periodFrom || !custom.periodTo) throw new Error('Custom counterparty-card period requires both dates');
    currentStart = new Date(`${custom.periodFrom}T00:00:00.000Z`);
    const customEnd = new Date(`${custom.periodTo}T00:00:00.000Z`);
    const lengthDays = Math.round((customEnd.getTime() - currentStart.getTime()) / 86_400_000) + 1;
    compareEnd = addDays(currentStart, -1);
    compareStart = addDays(compareEnd, -(lengthDays - 1));
    return {
      date: isoDay(year, month, day),
      preset,
      periodFrom: formatDay(currentStart),
      periodTo: formatDay(customEnd),
      compareFrom: formatDay(compareStart),
      compareTo: formatDay(compareEnd),
    };
  }

  if (preset === 'week') {
    const mondayOffset = (currentEnd.getUTCDay() + 6) % 7;
    currentStart = addDays(currentEnd, -mondayOffset);
    currentEnd = addDays(currentStart, 6);
    compareStart = addDays(currentStart, -7);
    compareEnd = addDays(compareStart, 6);
  } else if (preset === 'quarter') {
    const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
    currentStart = firstDayOfMonth(year, quarterStartMonth);
    currentEnd = lastDayOfMonth(year, quarterStartMonth + 2);
    compareStart = firstDayOfMonth(year, quarterStartMonth - 3);
    compareEnd = lastDayOfMonth(compareStart.getUTCFullYear(), compareStart.getUTCMonth() + 3);
  } else if (preset === 'halfYear') {
    const halfStartMonth = month <= 6 ? 1 : 7;
    currentStart = firstDayOfMonth(year, halfStartMonth);
    currentEnd = lastDayOfMonth(year, halfStartMonth + 5);
    compareStart = firstDayOfMonth(year, halfStartMonth - 6);
    compareEnd = lastDayOfMonth(compareStart.getUTCFullYear(), compareStart.getUTCMonth() + 6);
  } else if (preset === 'year') {
    currentStart = utcDay(year, 1, 1);
    currentEnd = utcDay(year, 12, 31);
    compareStart = utcDay(year - 1, 1, 1);
    compareEnd = utcDay(year - 1, 12, 31);
  } else {
    currentStart = utcDay(year, month, 1);
    currentEnd = lastDayOfMonth(year, month);
    compareStart = shiftMonthsCapped(currentStart, -1);
    compareEnd = lastDayOfMonth(compareStart.getUTCFullYear(), compareStart.getUTCMonth() + 1);
  }

  return {
    date: isoDay(year, month, day),
    preset,
    periodFrom: formatDay(currentStart),
    periodTo: formatDay(currentEnd),
    compareFrom: formatDay(compareStart),
    compareTo: formatDay(compareEnd),
  };
}

function cacheKey(payload: object, stale: boolean) {
  const stable = JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
  const hash = createHash('sha1').update(stable).digest('hex');
  return `counterparties:card:${stale ? 'stale' : 'fresh'}:${hash}`;
}

function remember(key: string, entry: CacheEntry) {
  if (memoryCache.size >= MAX_MEMORY_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest) memoryCache.delete(oldest);
  }
  memoryCache.set(key, { entry, expiresAt: Date.now() + CARD_STALE_TTL_SECONDS * 1000 });
}

function usable(entry: CacheEntry | null | undefined, maxAgeSeconds: number) {
  if (!entry?.value) return false;
  const timestamp = Date.parse(entry.fetchedAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= maxAgeSeconds * 1000;
}

async function readEntry(key: string, maxAgeSeconds: number) {
  const memory = memoryCache.get(key);
  if (memory && memory.expiresAt > Date.now() && usable(memory.entry, maxAgeSeconds)) return memory.entry;
  if (memory && memory.expiresAt <= Date.now()) memoryCache.delete(key);
  try {
    const cached = await cacheGet<CacheEntry>(key);
    if (usable(cached, maxAgeSeconds)) {
      remember(key, cached!);
      return cached!;
    }
  } catch {
    // Redis is an optimization. A live 1C request remains available.
  }
  return null;
}

async function persist(freshKey: string, staleKey: string, entry: CacheEntry) {
  remember(freshKey, entry);
  remember(staleKey, entry);
  await Promise.allSettled([
    cacheSet(freshKey, entry, CARD_FRESH_TTL_SECONDS),
    cacheSet(staleKey, entry, CARD_STALE_TTL_SECONDS),
  ]);
}

export function counterpartyCardPermissions(permissionNames: string[]): CounterpartyCardPermissions {
  const permissions = new Set(permissionNames);
  const granularPermissionNames = [
    'view_counterparty_finance',
    'view_counterparty_sales',
    'view_counterparty_contacts',
    'create_client_order_from_counterparty',
  ];
  // Compatibility is used only while a role has not been migrated to any of
  // the granular permissions. As soon as one granular permission is assigned,
  // the complete explicit set is enforced and view_client_orders cannot widen it.
  const legacyAccess = permissions.has('view_client_orders')
    && !granularPermissionNames.some((name) => permissions.has(name));
  return {
    viewFinance: legacyAccess || permissions.has('view_counterparty_finance'),
    viewSales: legacyAccess || permissions.has('view_counterparty_sales'),
    viewContacts: legacyAccess || permissions.has('view_counterparty_contacts'),
    createOrder: permissions.has('create_client_order_from_counterparty')
      || (legacyAccess && permissions.has('manage_client_orders')),
  };
}

function scopeCardToRequestedOrganization(
  card: CounterpartyCardBootstrap,
  organizationGuid?: string
): CounterpartyCardBootstrap {
  if (organizationGuid) return card;

  // A missing organization is valid for the future counterparty directory,
  // but financial values and commercial terms cannot be aggregated safely:
  // debt, limits, prohibitions and agreements have organization semantics.
  return {
    ...card,
    overview: {
      ...card.overview,
      status: null,
      debtTotal: null,
      overdueDebt: null,
      maxOverdueDays: null,
      availableCreditLimit: null,
    },
    financeSummary: null,
    incomingPayments: [],
    upcomingPayments: [],
    paymentDiscipline: null,
    financialDocuments: [],
    financialDocumentsSummary: {
      totalCount: 0,
      overdueCount: 0,
      pendingCount: 0,
      awaitingShipmentCount: 0,
    },
    commercialTerms: null,
    availability: {
      ...card.availability,
      finance: card.availability.finance === 'forbidden' ? 'forbidden' : 'unavailable',
      payments: card.availability.payments === 'forbidden' ? 'forbidden' : 'unavailable',
      upcomingPayments: card.availability.upcomingPayments === 'forbidden' ? 'forbidden' : 'unavailable',
      paymentDiscipline: card.availability.paymentDiscipline === 'forbidden' ? 'forbidden' : 'unavailable',
      financialDocuments: card.availability.financialDocuments === 'forbidden' ? 'forbidden' : 'unavailable',
      commercialTerms: 'unavailable',
    },
  };
}

export async function getCounterpartyCard(options: {
  counterpartyGuid: string;
  organizationGuid?: string;
  userId: number;
  permissionNames: string[];
  roleName?: string;
  preset?: CounterpartyPeriodPreset;
  periodFrom?: string;
  periodTo?: string;
  forceRefresh?: boolean;
}): Promise<CounterpartyCardBootstrap> {
  const periods = counterpartyCardPeriods(new Date(), options.preset ?? 'month', {
    periodFrom: options.periodFrom,
    periodTo: options.periodTo,
  });
  const elevated = ['admin', 'administrator'].includes(options.roleName?.trim().toLowerCase() ?? '');
  const permissions = elevated
    ? { viewFinance: true, viewSales: true, viewContacts: true, createOrder: true }
    : counterpartyCardPermissions(options.permissionNames);
  const payload = {
    contractVersion: CARD_CONTRACT_VERSION,
    counterpartyGuid: options.counterpartyGuid.toLowerCase(),
    organizationGuid: options.organizationGuid?.toLowerCase() ?? null,
    preset: periods.preset,
    periodFrom: periods.periodFrom,
    periodTo: periods.periodTo,
    compareFrom: periods.compareFrom,
    compareTo: periods.compareTo,
    permissions,
  };
  const freshKey = cacheKey(payload, false);
  const staleKey = cacheKey(payload, true);

  const loadLive = () => {
    const existing = pendingReads.get(freshKey);
    if (existing) return existing;

    const task = (async () => {
    try {
      const query: OnecLpAppQuery = {
        counterpartyGuid: options.counterpartyGuid,
        organizationGuid: options.organizationGuid,
        period: periods.preset === 'halfYear' ? 'half-year' : periods.preset,
        periodFrom: periods.periodFrom,
        periodTo: periods.periodTo,
        compareFrom: periods.compareFrom,
        compareTo: periods.compareTo,
      };
      const upstream = await getOnecLpAppCounterpartyCard(query);
      const value = scopeCardToRequestedOrganization(
        mapOnecCounterpartyCard(
          upstream,
          options.counterpartyGuid,
          options.organizationGuid ?? null,
          permissions
        ),
        options.organizationGuid
      );
      const entry = { value, fetchedAt: new Date().toISOString() };
      await persist(freshKey, staleKey, entry);
      return value;
    } catch (error) {
      const stale = await readEntry(staleKey, CARD_STALE_TTL_SECONDS);
      if (stale) return { ...stale.value, stale: true };
      if (error instanceof OnecLpAppHttpError && error.upstreamStatus === 404) {
        throw new CounterpartiesError(404, ErrorCodes.NOT_FOUND, 'Контрагент не найден в 1С.');
      }
      throw error;
    }
    })().finally(() => pendingReads.delete(freshKey));

    pendingReads.set(freshKey, task);
    return task;
  };

  if (!options.forceRefresh) {
    const cached = await readEntry(freshKey, CARD_FRESH_TTL_SECONDS);
    if (cached) return { ...cached.value, stale: false };

    // Stale-while-revalidate: keep navigation responsive while the expensive
    // 1C aggregate is recalculated. Single-flight prevents duplicate refreshes.
    const stale = await readEntry(staleKey, CARD_STALE_TTL_SECONDS);
    if (stale) {
      void loadLive().catch((error) => {
        console.warn('[counterparties] background card refresh failed', {
          counterpartyGuid: options.counterpartyGuid,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return { ...stale.value, stale: true };
    }
  }

  return loadLive();
}
