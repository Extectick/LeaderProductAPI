import { Markup, Telegraf } from 'telegraf';

type TelegramUpdateHandler = (update: unknown) => Promise<void> | void;
type TelegramUpdatesMode = 'auto' | 'webhook' | 'polling';

let cachedBot: Telegraf | null = null;
let cachedToken = '';
let updateHandler: TelegramUpdateHandler | null = null;
let pollingHandlersAttached = false;
let pollingLaunched = false;

function getBotToken() {
  return String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function getBotUsername() {
  return String(process.env.TELEGRAM_BOT_USERNAME || '').trim();
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/^"+|"+$/g, '').replace(/\/+$/g, '').trim();
}

function getWebhookSecret() {
  return String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
}

function getUpdatesMode(): TelegramUpdatesMode {
  const raw = String(process.env.TELEGRAM_UPDATES_MODE || 'auto').trim().toLowerCase();
  if (raw === 'webhook') return 'webhook';
  if (raw === 'polling') return 'polling';
  return process.env.NODE_ENV === 'production' ? 'auto' : 'polling';
}

function getConfiguredWebhookUrl() {
  const explicitWebhookUrl = normalizeBaseUrl(String(process.env.TELEGRAM_WEBHOOK_URL || ''));
  if (explicitWebhookUrl) return explicitWebhookUrl;

  const domainUrl = normalizeBaseUrl(String(process.env.DOMEN_URL || process.env.DOMAIN_URL || ''));
  if (!domainUrl) return '';
  return `${domainUrl}/auth/telegram/webhook`;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

function isWebhookLikelyPublicAndReachable(webhookUrl: string): boolean {
  if (!webhookUrl) return false;
  try {
    const parsed = new URL(webhookUrl);
    if (parsed.protocol !== 'https:') return false;
    if (isPrivateHost(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function getBot(): Telegraf | null {
  const token = getBotToken();
  if (!token) return null;

  if (!cachedBot || cachedToken !== token) {
    cachedBot = new Telegraf(token);
    cachedToken = token;
  }

  return cachedBot;
}

export function isTelegramBotConfigured(): boolean {
  return Boolean(getBotToken() && getBotUsername());
}

export async function ensureTelegramWebhook(): Promise<{
  ok: boolean;
  mode: 'webhook';
  reason?: string;
  expectedUrl?: string;
  currentUrl?: string;
  pendingUpdates?: number;
  lastErrorMessage?: string;
}> {
  const bot = getBot();
  if (!bot) {
    return { ok: false, mode: 'webhook', reason: 'BOT_TOKEN_NOT_CONFIGURED' };
  }

  const expectedUrl = getConfiguredWebhookUrl();
  if (!expectedUrl) {
    return { ok: false, mode: 'webhook', reason: 'WEBHOOK_URL_NOT_CONFIGURED' };
  }

  const secret = getWebhookSecret();
  const infoBefore = await bot.telegram.getWebhookInfo();

  const currentUrl = String(infoBefore?.url || '');
  if (currentUrl !== expectedUrl) {
    await bot.telegram.setWebhook(expectedUrl, {
      secret_token: secret || undefined,
      drop_pending_updates: false,
    });
  }

  const infoAfter = await bot.telegram.getWebhookInfo();
  return {
    ok: String(infoAfter?.url || '') === expectedUrl,
    mode: 'webhook',
    expectedUrl,
    currentUrl: String(infoAfter?.url || ''),
    pendingUpdates: Number(infoAfter?.pending_update_count || 0),
    lastErrorMessage: infoAfter?.last_error_message || undefined,
  };
}

export function registerTelegramUpdateHandler(handler: TelegramUpdateHandler) {
  updateHandler = handler;
}

async function startTelegramLongPolling(bot: Telegraf): Promise<{
  ok: boolean;
  mode: 'polling';
  reason?: string;
}> {
  if (!updateHandler) {
    return { ok: false, mode: 'polling', reason: 'UPDATE_HANDLER_NOT_REGISTERED' };
  }

  if (!pollingHandlersAttached) {
    bot.on('message', async (ctx) => {
      if (!updateHandler) return;
      try {
        await updateHandler(ctx.update);
      } catch (e: any) {
        console.warn('[tg-bot] update handler failed:', e?.message || e);
      }
    });
    pollingHandlersAttached = true;
  }

  if (pollingLaunched) {
    return { ok: true, mode: 'polling' };
  }

  await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
  await bot.launch({ dropPendingUpdates: false });
  pollingLaunched = true;
  return { ok: true, mode: 'polling' };
}

export async function initializeTelegramUpdates(): Promise<{
  ok: boolean;
  mode: 'webhook' | 'polling';
  reason?: string;
  expectedUrl?: string;
  currentUrl?: string;
  pendingUpdates?: number;
  lastErrorMessage?: string;
}> {
  const bot = getBot();
  if (!bot) {
    return { ok: false, mode: 'polling', reason: 'BOT_TOKEN_NOT_CONFIGURED' };
  }

  const mode = getUpdatesMode();
  const expectedWebhookUrl = getConfiguredWebhookUrl();

  if (mode === 'polling') {
    return startTelegramLongPolling(bot);
  }

  if (mode === 'auto' && !isWebhookLikelyPublicAndReachable(expectedWebhookUrl)) {
    return startTelegramLongPolling(bot);
  }

  const webhook = await ensureTelegramWebhook();
  if (webhook.ok || mode === 'webhook') {
    return webhook;
  }

  return startTelegramLongPolling(bot);
}

export async function stopTelegramUpdates() {
  if (!pollingLaunched || !cachedBot) return;
  cachedBot.stop('app_shutdown');
  pollingLaunched = false;
}

export async function sendPhoneContactRequestMessage(params: {
  chatId: string | number | bigint;
  requestedPhone?: string | null;
}) {
  const bot = getBot();
  if (!bot) return false;

  const chatId = String(params.chatId);
  const phoneHint = params.requestedPhone ? ` ${params.requestedPhone}` : '';
  await bot.telegram.sendMessage(
    chatId,
    `Для подтверждения номера${phoneHint} нажмите кнопку ниже и отправьте контакт.`,
    {
      reply_markup: Markup.keyboard([
        [Markup.button.contactRequest('Отправить контакт')],
      ])
        .resize()
        .oneTime()
        .reply_markup,
    }
  );

  return true;
}

export async function sendTelegramInfoMessage(params: {
  chatId: string | number | bigint;
  text: string;
  removeKeyboard?: boolean;
}) {
  const bot = getBot();
  if (!bot) return false;

  const options = params.removeKeyboard
    ? { reply_markup: Markup.removeKeyboard().reply_markup }
    : undefined;

  await bot.telegram.sendMessage(String(params.chatId), params.text, options);
  return true;
}
