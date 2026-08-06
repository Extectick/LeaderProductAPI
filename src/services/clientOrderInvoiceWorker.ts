import {
  ClientOrderInvoiceDeliveryChannel,
  ClientOrderInvoiceDeliveryState,
  ClientOrderInvoiceState,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import prisma from '../prisma/client';
import { getRedis } from '../lib/redis';
import {
  ackOnecLpAppClientOrderInvoice,
  getOnecLpAppClientOrderInvoicePdf,
  getOnecLpAppClientOrderInvoices,
  validateOnecLpAppClientOrderInvoice,
  type OnecClientOrderInvoiceQueueItem,
} from '../modules/onec/onec.lpApp.client';
import { buildStoragePrefix, uploadBuffer } from '../storage/minio';
import { sendTelegramDocument } from './telegramBotService';
import { sendMaxDocument } from './maxBotService';

const LOCK_KEY = 'client-orders:invoice-worker:lock';
const ACTIVE_STATES: ClientOrderInvoiceState[] = [
  ClientOrderInvoiceState.WAITING,
  ClientOrderInvoiceState.QUEUED,
  ClientOrderInvoiceState.SENDING,
  ClientOrderInvoiceState.AVAILABLE,
  ClientOrderInvoiceState.PARTIAL,
  ClientOrderInvoiceState.ERROR,
];
const RETRYABLE_STATES: ClientOrderInvoiceState[] = [
  ClientOrderInvoiceState.QUEUED,
  ClientOrderInvoiceState.SENDING,
  ClientOrderInvoiceState.PARTIAL,
  ClientOrderInvoiceState.ERROR,
];
const PROCESSABLE_STATES: ClientOrderInvoiceState[] = [
  ...RETRYABLE_STATES,
  ClientOrderInvoiceState.AVAILABLE,
];

let timer: NodeJS.Timeout | null = null;
let running = false;
let inMemoryLock = false;

function envInt(name: string, fallback: number, min = 1) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.trunc(raw) : fallback;
}

function intervalMs() {
  return envInt('CLIENT_ORDER_INVOICE_WORKER_INTERVAL_MS', 15_000, 1_000);
}

function batchSize() {
  return envInt('CLIENT_ORDER_INVOICE_WORKER_BATCH_SIZE', 10, 1);
}

function leaseMs() {
  return envInt('CLIENT_ORDER_INVOICE_WORKER_LEASE_MS', 120_000, 10_000);
}

function stabilityMs() {
  return envInt('CLIENT_ORDER_INVOICE_STABILITY_MS', 0, 0);
}

function backoffMs(attempts: number) {
  const base = envInt('CLIENT_ORDER_INVOICE_BACKOFF_BASE_MS', 15_000, 1_000);
  const max = envInt('CLIENT_ORDER_INVOICE_BACKOFF_MAX_MS', 900_000, base);
  return Math.min(max, base * 2 ** Math.max(0, attempts - 1));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Unknown invoice worker error');
}

function parseDate(value?: string | null) {
  if (!value) return null;
  const normalized = value.trim();
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  if (!hasExplicitOffset) {
    const match = normalized.match(
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
    );
    if (match) {
      const offsetMinutes = envInt('ONEC_LP_APP_TIMEZONE_OFFSET_MINUTES', 180, -840);
      const milliseconds = Number((match[7] ?? '').padEnd(3, '0')) || 0;
      return new Date(
        Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
          milliseconds
        ) - offsetMinutes * 60_000
      );
    }
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function optionalText(value: unknown) {
  const text = String(value ?? '').trim();
  return text || null;
}

function invoiceAmount(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapOnecState(state: OnecClientOrderInvoiceQueueItem['state']): ClientOrderInvoiceState {
  if (state === 'CANCELLED') return ClientOrderInvoiceState.CANCELLED;
  if (state === 'READY') return ClientOrderInvoiceState.QUEUED;
  if (state === 'STORED') return ClientOrderInvoiceState.AVAILABLE;
  return state as ClientOrderInvoiceState;
}

function unwrapValidation(value: unknown): OnecClientOrderInvoiceQueueItem | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, any>;
  return (record.item ?? record.body?.item ?? record.body ?? record.data?.item ?? record.data ?? record) as OnecClientOrderInvoiceQueueItem;
}

function sameCandidate(expected: { token: string; businessHash: string | null }, actual: OnecClientOrderInvoiceQueueItem | null) {
  return Boolean(
    actual &&
    actual.token === expected.token &&
    (actual.businessHash ?? null) === expected.businessHash &&
    ['READY', 'QUEUED', 'PARTIAL', 'SENDING', 'STORED'].includes(actual.state)
  );
}

async function acquireLock() {
  const lockId = randomUUID();
  try {
    const redis = getRedis();
    if (redis.isOpen) {
      const result = await redis.set(LOCK_KEY, lockId, { NX: true, PX: leaseMs() });
      if (result !== 'OK') return null;
      return async () => {
        try {
          if (await redis.get(LOCK_KEY) === lockId) await redis.del(LOCK_KEY);
        } catch {
          // TTL remains the final lock guard.
        }
      };
    }
  } catch {
    // A database lease plus the in-memory guard keep a single process safe.
  }

  if (inMemoryLock) return null;
  inMemoryLock = true;
  return async () => {
    inMemoryLock = false;
  };
}

export async function syncQueueItem(
  item: OnecClientOrderInvoiceQueueItem,
  options: { immediate?: boolean } = {}
) {
  if (!item.appOrderGuid || !item.realizationGuid || !item.token) return;
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid: item.appOrderGuid },
      select: { id: true },
    });
    if (!order) return;

    const current = await tx.clientOrderInvoice.findUnique({ where: { token: item.token } });
    // Токен 1С идентифицирует конкретную версию кандидата и уже обеспечивает
    // идемпотентность повторной обработки. Совпадение хеша с более старой
    // отправленной версией не является дублем: после v1 -> v2 -> v3 содержимое
    // v3 может снова совпасть с v1, но относительно v2 это новое изменение,
    // которое должно получить новый PDF и отдельную доставку.
    const onecState = mapOnecState(item.state);
    const incomingReadyAt = parseDate(item.readyAt);
    // The old 1C extension exposed an artificial +30 second readyAt. The
    // business hash and token already protect us from an unstable/stale PDF,
    // so a READY item is processable immediately. Clamp a future legacy value
    // instead of carrying the delay into the API queue.
    const effectiveReadyAt = onecState === ClientOrderInvoiceState.QUEUED && options.immediate
      ? new Date(Math.min(incomingReadyAt?.getTime() ?? Date.now(), Date.now()))
      : incomingReadyAt;
    const incomingRealizationDate = parseDate(item.realizationDate);
    if (!current) {
      await tx.clientOrderInvoice.updateMany({
        where: {
          orderId: order.id,
          realizationGuid: item.realizationGuid,
          token: { not: item.token },
          state: { in: ACTIVE_STATES },
        },
        data: {
          state: ClientOrderInvoiceState.SUPERSEDED,
          supersededAt: new Date(),
          leaseUntil: null,
          lastError: 'Заменён более новой версией счёта',
        },
      });
    }

    const incomingUpdate = parseDate(item.updatedAt);
    await tx.clientOrderInvoice.upsert({
      where: { token: item.token },
      create: {
        orderId: order.id,
        realizationGuid: item.realizationGuid,
        realizationNumber: item.realizationNumber ?? null,
        realizationDate: incomingRealizationDate,
        invoiceAmount: invoiceAmount(item.invoiceAmount),
        currency: optionalText(item.currency),
        counterpartyName: optionalText(item.counterpartyName),
        organizationName: optionalText(item.organizationName),
        orderNumber: optionalText(item.orderNumber),
        businessHash: item.businessHash ?? null,
        version: Math.max(0, Number(item.version) || 0),
        token: item.token,
        state: onecState,
        waitReason: item.waitReason ?? null,
        readyAt: effectiveReadyAt ?? (onecState === ClientOrderInvoiceState.QUEUED
          ? new Date(Date.now() + stabilityMs())
          : null),
        nextAttemptAt: onecState === ClientOrderInvoiceState.QUEUED ? new Date() : null,
        onecUpdatedAt: incomingUpdate,
      },
      update: {
        realizationNumber: item.realizationNumber ?? null,
        realizationDate: incomingRealizationDate,
        invoiceAmount: invoiceAmount(item.invoiceAmount),
        currency: optionalText(item.currency),
        counterpartyName: optionalText(item.counterpartyName),
        organizationName: optionalText(item.organizationName),
        orderNumber: optionalText(item.orderNumber),
        businessHash: item.businessHash ?? null,
        version: Math.max(0, Number(item.version) || 0),
        waitReason: item.waitReason ?? null,
        ...(effectiveReadyAt
          ? { readyAt: effectiveReadyAt }
          : onecState === ClientOrderInvoiceState.QUEUED && current?.state === ClientOrderInvoiceState.WAITING
            ? { readyAt: new Date(Date.now() + stabilityMs()) }
            : {}),
        onecUpdatedAt: incomingUpdate,
        ...(current?.state === ClientOrderInvoiceState.SENT
          ? {}
          : current?.state === ClientOrderInvoiceState.SENDING && current.leaseUntil && current.leaseUntil > new Date()
            ? {}
            : { state: onecState }),
      },
    });
  });
}

async function syncOnecQueue() {
  const response = await getOnecLpAppClientOrderInvoices(
    envInt('CLIENT_ORDER_INVOICE_WORKER_QUEUE_LIMIT', 100, 1)
  );
  const items = Array.isArray((response as any)?.items)
    ? (response as any).items
    : Array.isArray((response as any)?.body?.items)
      ? (response as any).body.items
    : Array.isArray((response as any)?.data?.items)
      ? (response as any).data.items
      : [];
  const latestByRealization = new Map<string, OnecClientOrderInvoiceQueueItem>();
  for (const item of items as OnecClientOrderInvoiceQueueItem[]) {
    const key = `${item.appOrderGuid}:${item.realizationGuid}`.toLowerCase();
    const previous = latestByRealization.get(key);
    const previousTime = parseDate(previous?.updatedAt)?.getTime() ?? 0;
    const itemTime = parseDate(item.updatedAt)?.getTime() ?? 0;
    if (!previous || itemTime > previousTime || (itemTime === previousTime && item.version >= previous.version)) {
      latestByRealization.set(key, item);
    }
  }
  for (const item of latestByRealization.values()) {
    await syncQueueItem(item);
  }
}

function safeDocumentPart(value: string | null | undefined) {
  return String(value || 'realization').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'realization';
}

function formatInvoiceDate(value: Date | string | null | undefined) {
  if (!value) return 'б/д';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'б/д';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

function formatInvoiceAmount(value: unknown, currency: string | null | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const code = String(currency || 'RUB').trim().toUpperCase();
  const symbol = code === 'RUB' || code === 'RUR' ? '₽' : code === 'USD' ? '$' : code === 'EUR' ? '€' : code;
  return `${amount.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${symbol}`;
}

export function buildInvoiceFileName(params: {
  realizationNumber: string | null;
  realizationGuid: string;
  realizationDate: Date | string | null;
  version: number;
}) {
  const number = safeDocumentPart(params.realizationNumber || params.realizationGuid);
  const version = Math.max(1, params.version);
  const versionSuffix = version > 1 ? `, версия ${version}` : '';
  return `Счет №${number} от ${formatInvoiceDate(params.realizationDate)}${versionSuffix}.pdf`;
}

export function buildInvoiceMessage(params: {
  realizationNumber: string | null;
  realizationGuid: string;
  realizationDate: Date | string | null;
  version: number;
  invoiceAmount: unknown;
  currency: string | null;
  counterpartyName: string | null;
  organizationName: string | null;
  orderNumber: string | null;
}) {
  const number = params.realizationNumber || params.realizationGuid;
  const amount = formatInvoiceAmount(params.invoiceAmount, params.currency);
  const lines = [
    'Добрый день!',
    `Направляем счёт на оплату ${number} от ${formatInvoiceDate(params.realizationDate)}.`,
  ];
  if (amount) lines.push(`Сумма к оплате: ${amount}.`);
  return lines.join('\n');
}

async function markSuperseded(invoiceId: string) {
  await prisma.clientOrderInvoice.update({
    where: { id: invoiceId },
    data: {
      state: ClientOrderInvoiceState.SUPERSEDED,
      supersededAt: new Date(),
      leaseUntil: null,
      lastError: 'Кандидат счёта устарел до отправки',
    },
  });
}

async function validateCandidate(invoice: { id: string; token: string; businessHash: string | null }) {
  const actual = unwrapValidation(await validateOnecLpAppClientOrderInvoice(invoice.token));
  if (sameCandidate(invoice, actual)) return true;
  await markSuperseded(invoice.id);
  return false;
}

async function ensurePdf(invoice: {
  id: string;
  token: string;
  businessHash: string | null;
  realizationGuid: string;
  realizationNumber: string | null;
  realizationDate: Date | null;
  version: number;
  s3Key: string | null;
  fileName: string | null;
}) {
  if (invoice.s3Key) return;
  if (!(await validateCandidate(invoice))) throw new Error('INVOICE_SUPERSEDED');
  const pdf = await getOnecLpAppClientOrderInvoicePdf(invoice.token);
  if (pdf.body.length < 5 || pdf.body.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('1C returned an invalid invoice PDF');
  }
  if (!(await validateCandidate(invoice))) throw new Error('INVOICE_SUPERSEDED');

  const fileName = buildInvoiceFileName(invoice);
  const key = `${buildStoragePrefix('invoices')}/${invoice.id}/${safeDocumentPart(invoice.businessHash)}.pdf`;
  await uploadBuffer(key, pdf.body, pdf.contentType || 'application/pdf', true, fileName, {
    cacheControl: 'private, max-age=0, no-store',
  });
  await prisma.clientOrderInvoice.update({
    where: { id: invoice.id },
    data: {
      s3Key: key,
      fileName,
      contentType: pdf.contentType || 'application/pdf',
      fileSize: pdf.body.length,
    },
  });
}

type DeliveryContext = {
  channel: ClientOrderInvoiceDeliveryChannel;
  enabled: boolean;
  recipient: bigint | null;
  disabledReason: string;
};

async function deliverChannel(params: {
  invoiceId: string;
  invoiceToken: string;
  businessHash: string | null;
  channel: DeliveryContext;
  buffer: Buffer;
  fileName: string;
  caption: string;
}) {
  const existing = await prisma.clientOrderInvoiceDelivery.upsert({
    where: { invoiceId_channel: { invoiceId: params.invoiceId, channel: params.channel.channel } },
    create: { invoiceId: params.invoiceId, channel: params.channel.channel },
    update: {},
  });
  if (existing.state === ClientOrderInvoiceDeliveryState.SENT) return 'SENT' as const;

  if (!params.channel.enabled || params.channel.recipient === null) {
    await prisma.clientOrderInvoiceDelivery.update({
      where: { id: existing.id },
      data: { state: ClientOrderInvoiceDeliveryState.SKIPPED, lastError: params.channel.disabledReason },
    });
    return 'SKIPPED' as const;
  }

  if (existing.nextAttemptAt && existing.nextAttemptAt > new Date()) return 'ERROR' as const;
  const currentInvoice = await prisma.clientOrderInvoice.findUnique({
    where: { id: params.invoiceId },
    select: { id: true, token: true, businessHash: true },
  });
  if (!currentInvoice || !(await validateCandidate(currentInvoice))) return 'SUPERSEDED' as const;

  await prisma.clientOrderInvoiceDelivery.update({
    where: { id: existing.id },
    data: { state: ClientOrderInvoiceDeliveryState.SENDING, attempts: { increment: 1 }, lastError: null },
  });
  try {
    if (params.channel.channel === ClientOrderInvoiceDeliveryChannel.TELEGRAM) {
      const sent = await sendTelegramDocument({
        chatId: params.channel.recipient,
        buffer: params.buffer,
        fileName: params.fileName,
        caption: params.caption,
      });
      if (!sent) throw new Error('Telegram bot is not configured');
    } else {
      const sent = await sendMaxDocument({
        chatId: params.channel.recipient,
        buffer: params.buffer,
        fileName: params.fileName,
        caption: params.caption,
      });
      if (!sent) throw new Error('MAX bot is not configured');
    }
    await prisma.clientOrderInvoiceDelivery.update({
      where: { id: existing.id },
      data: { state: ClientOrderInvoiceDeliveryState.SENT, sentAt: new Date(), nextAttemptAt: null, lastError: null },
    });
    return 'SENT' as const;
  } catch (error) {
    const attempts = existing.attempts + 1;
    await prisma.clientOrderInvoiceDelivery.update({
      where: { id: existing.id },
      data: {
        state: ClientOrderInvoiceDeliveryState.ERROR,
        lastError: errorMessage(error),
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      },
    });
    return 'ERROR' as const;
  }
}

export async function processInvoice(invoiceId: string) {
  const leaseUntil = new Date(Date.now() + leaseMs());
  const claimed = await prisma.clientOrderInvoice.updateMany({
    where: {
      id: invoiceId,
      state: { in: PROCESSABLE_STATES },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
    },
    data: { state: ClientOrderInvoiceState.SENDING, leaseUntil, attempts: { increment: 1 }, lastError: null },
  });
  if (!claimed.count) return;

  const invoice = await prisma.clientOrderInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      order: {
        select: {
          invoiceRequested: true,
          number1c: true,
          date1c: true,
          totalAmount: true,
          currency: true,
          createdByUser: {
            select: {
              telegramId: true,
              maxId: true,
              notificationSettings: {
                select: { telegramNotificationsEnabled: true, maxNotificationsEnabled: true },
              },
            },
          },
        },
      },
    },
  });
  if (!invoice) return;
  try {
    if (!(await validateCandidate(invoice))) return;
    await ensurePdf(invoice);
    const refreshed = await prisma.clientOrderInvoice.findUnique({
      where: { id: invoice.id },
      select: {
        s3Key: true,
        fileName: true,
        order: { select: { invoiceRequested: true } },
      },
    });
    if (!refreshed?.s3Key || !refreshed.fileName) throw new Error('Invoice PDF was not persisted');
    if (!refreshed.order.invoiceRequested) {
      await prisma.clientOrderInvoice.update({
        where: { id: invoice.id },
        data: {
          state: ClientOrderInvoiceState.AVAILABLE,
          waitReason: null,
          lastError: null,
          leaseUntil: null,
          nextAttemptAt: null,
        },
      });
      await ackOnecLpAppClientOrderInvoice(invoice.token, {
        state: 'STORED',
        error: null,
        sentAt: null,
      });
      return;
    }
    const { downloadBuffer } = await import('../storage/minio');
    const pdf = await downloadBuffer(refreshed.s3Key);
    const user = invoice.order.createdByUser;
    if (!user) throw new Error('У заказа не указан менеджер для отправки счёта');
    const settings = user.notificationSettings;
    const channels: DeliveryContext[] = [
      {
        channel: ClientOrderInvoiceDeliveryChannel.TELEGRAM,
        enabled: settings?.telegramNotificationsEnabled ?? true,
        recipient: user.telegramId,
        disabledReason: user.telegramId ? 'Уведомления Telegram отключены' : 'Telegram не привязан',
      },
      {
        channel: ClientOrderInvoiceDeliveryChannel.MAX,
        enabled: settings?.maxNotificationsEnabled ?? true,
        recipient: user.maxId,
        disabledReason: user.maxId ? 'Уведомления MAX отключены' : 'MAX не привязан',
      },
    ];
    const caption = buildInvoiceMessage({
      realizationNumber: invoice.realizationNumber,
      realizationGuid: invoice.realizationGuid,
      realizationDate: invoice.realizationDate ?? invoice.order.date1c,
      version: invoice.version,
      invoiceAmount: invoice.invoiceAmount ?? invoice.order.totalAmount,
      currency: invoice.currency ?? invoice.order.currency,
      counterpartyName: invoice.counterpartyName,
      organizationName: invoice.organizationName,
      orderNumber: invoice.orderNumber ?? invoice.order.number1c,
    });
    const results: string[] = [];
    for (const channel of channels) {
      results.push(await deliverChannel({
        invoiceId: invoice.id,
        invoiceToken: invoice.token,
        businessHash: invoice.businessHash,
        channel,
        buffer: pdf.body,
        fileName: refreshed.fileName,
        caption,
      }));
      if (results.includes('SUPERSEDED')) return;
    }

    const eligibleCount = channels.filter((channel) => channel.enabled && channel.recipient !== null).length;
    const eligibleResults = results.filter((_result, index) => channels[index].enabled && channels[index].recipient !== null);
    const sentCount = eligibleResults.filter((result) => result === 'SENT').length;
    const failedCount = eligibleResults.filter((result) => result === 'ERROR').length;
    const hasHistoricalDelivery = results.includes('SENT');
    const finalState = eligibleCount === 0
      ? (hasHistoricalDelivery ? ClientOrderInvoiceState.SENT : ClientOrderInvoiceState.ERROR)
      : failedCount === 0 && sentCount === eligibleCount
        ? ClientOrderInvoiceState.SENT
        : sentCount > 0
          ? ClientOrderInvoiceState.PARTIAL
          : ClientOrderInvoiceState.ERROR;
    const skippedReasons = channels
      .filter((_channel, index) => results[index] === 'SKIPPED')
      .map((channel) => channel.disabledReason);
    const finalError = finalState === ClientOrderInvoiceState.SENT
      ? null
      : [...skippedReasons, failedCount ? 'Не все каналы приняли счёт' : 'Нет доступных каналов доставки'].join('; ');
    const sentAt = finalState === ClientOrderInvoiceState.SENT ? new Date() : null;
    await prisma.clientOrderInvoice.update({
      where: { id: invoice.id },
      data: {
        state: finalState,
        waitReason: finalError,
        lastError: finalError,
        sentAt,
        leaseUntil: null,
        nextAttemptAt: finalState === ClientOrderInvoiceState.SENT
          ? null
          : new Date(Date.now() + backoffMs(invoice.attempts + 1)),
      },
    });
    const ackState = finalState === ClientOrderInvoiceState.SENT
      ? 'SENT'
      : finalState === ClientOrderInvoiceState.PARTIAL
        ? 'PARTIAL'
        : 'ERROR';
    await ackOnecLpAppClientOrderInvoice(invoice.token, {
      state: ackState,
      error: finalError,
      sentAt: sentAt?.toISOString() ?? null,
    });
  } catch (error) {
    if (errorMessage(error) === 'INVOICE_SUPERSEDED') return;
    const attempts = invoice.attempts + 1;
    await prisma.clientOrderInvoice.updateMany({
      where: { id: invoice.id, state: { not: ClientOrderInvoiceState.SUPERSEDED } },
      data: {
        state: ClientOrderInvoiceState.ERROR,
        lastError: errorMessage(error),
        leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      },
    });
    await ackOnecLpAppClientOrderInvoice(invoice.token, {
      state: 'ERROR',
      error: errorMessage(error),
    }).catch(() => undefined);
  }
}

async function runOnce() {
  const release = await acquireLock();
  if (!release) return;
  try {
    await syncOnecQueue();
    const now = new Date();
    const candidates = await prisma.clientOrderInvoice.findMany({
      where: {
        AND: [
          {
            OR: [
              { state: { in: RETRYABLE_STATES } },
              { state: ClientOrderInvoiceState.AVAILABLE, order: { invoiceRequested: true } },
            ],
          },
          { OR: [{ readyAt: null }, { readyAt: { lte: now } }] },
          { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        ],
      },
      orderBy: [{ readyAt: 'asc' }, { updatedAt: 'asc' }],
      take: batchSize(),
      select: { id: true },
    });
    for (const candidate of candidates) await processInvoice(candidate.id);
  } catch (error) {
    console.error('[client-order-invoice-worker] run failed:', errorMessage(error));
  } finally {
    await release();
  }
}

function schedule() {
  if (!running) return;
  timer = setTimeout(async () => {
    await runOnce();
    schedule();
  }, intervalMs());
}

export function startClientOrderInvoiceWorker() {
  if (running || process.env.CLIENT_ORDER_INVOICE_WORKER_DISABLED === '1') return;
  running = true;
  console.log('[client-order-invoice-worker] started', { intervalMs: intervalMs(), batchSize: batchSize() });
  void runOnce();
  schedule();
}

export function stopClientOrderInvoiceWorker() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
