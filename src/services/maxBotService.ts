import { Bot } from '@maxhub/max-bot-api';

type MaxUpdateHandler = (update: unknown) => Promise<void> | void;
type MaxUpdatesMode = 'auto' | 'webhook' | 'polling';

const MAX_API_BASE = 'https://platform-api.max.ru';
const DEFAULT_UPDATE_TYPES = ['message_created', 'bot_started'];

let cachedBot: Bot | null = null;
let cachedToken = '';
let updateHandler: MaxUpdateHandler | null = null;
let pollingHandlersAttached = false;
let pollingLaunched = false;

function getBotToken() {
  return String(process.env.MAX_BOT_TOKEN || '').trim();
}

function getBotUsername() {
  return String(process.env.MAX_BOT_USERNAME || '').trim();
}

function getCompanyName() {
  return String(process.env.BOT_COMPANY_NAME || 'Лидер Продукт').trim();
}

function getWelcomeLogoUrl() {
  return String(process.env.BOT_WELCOME_LOGO_URL || '').trim();
}

function buildMaxMiniAppLink(startParam = 'home') {
  const botUsername = getBotUsername().replace(/^@+/, '');
  if (!botUsername) return '';
  return `https://max.ru/${botUsername}?startapp=${encodeURIComponent(startParam)}`;
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/^"+|"+$/g, '').replace(/\/+$/g, '').trim();
}

function getWebhookSecret() {
  return String(process.env.MAX_WEBHOOK_SECRET || '').trim();
}

function getUpdatesMode(): MaxUpdatesMode {
  const raw = String(process.env.MAX_UPDATES_MODE || 'auto').trim().toLowerCase();
  if (raw === 'webhook') return 'webhook';
  if (raw === 'polling') return 'polling';
  return process.env.NODE_ENV === 'production' ? 'auto' : 'polling';
}

function getConfiguredWebhookUrl() {
  const explicitWebhookUrl = normalizeBaseUrl(String(process.env.MAX_WEBHOOK_URL || ''));
  if (explicitWebhookUrl) return explicitWebhookUrl;

  const domainUrl = normalizeBaseUrl(String(process.env.DOMEN_URL || process.env.DOMAIN_URL || ''));
  if (!domainUrl) return '';
  return `${domainUrl}/auth/max/webhook`;
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

function toIntId(id: string | number | bigint) {
  const num = Number(id);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('Invalid MAX chat/user id');
  }
  return Math.trunc(num);
}

function normalizeWhitespace(text: string) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToPlainText(text: string) {
  if (!text) return '';
  let out = String(text);
  // links: <a href="url">label</a> => label (url)
  out = out.replace(/<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, href, label) => {
    const cleanLabel = String(label || '').replace(/<[^>]+>/g, '').trim();
    const cleanHref = String(href || '').trim();
    if (!cleanHref) return cleanLabel;
    return cleanLabel ? `${cleanLabel} (${cleanHref})` : cleanHref;
  });
  // common inline html tags used in templates
  out = out.replace(/<\/?(b|strong|i|em|u|code|pre)>/gi, '');
  // any remaining tags
  out = out.replace(/<[^>]+>/g, '');
  // very small entities set we actually use
  out = out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return normalizeWhitespace(out);
}

function getBot(): Bot | null {
  const token = getBotToken();
  if (!token) return null;

  if (!cachedBot || cachedToken !== token) {
    cachedBot = new Bot(token);
    cachedToken = token;
    pollingHandlersAttached = false;
    pollingLaunched = false;
  }
  return cachedBot;
}

async function callMaxApi(path: string, options: { method?: string; body?: Record<string, any> } = {}) {
  const token = getBotToken();
  if (!token) throw new Error('MAX_BOT_TOKEN is not configured');

  const response = await fetch(`${MAX_API_BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data: any = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { status: response.status, ok: response.ok, data };
}

function extractSubscriptionUrl(payload: any): string {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.url === 'string') return payload.url;
  if (payload.subscription && typeof payload.subscription.url === 'string') return payload.subscription.url;
  if (Array.isArray(payload.subscriptions) && payload.subscriptions.length) {
    const first = payload.subscriptions[0];
    if (first && typeof first.url === 'string') return first.url;
  }
  if (Array.isArray(payload) && payload.length && typeof payload[0]?.url === 'string') {
    return payload[0].url;
  }
  return '';
}

function extractLastError(payload: any): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
  return undefined;
}

export function isMaxBotConfigured(): boolean {
  return Boolean(getBotToken() && getBotUsername());
}

export async function ensureMaxWebhook(): Promise<{
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

  const before = await callMaxApi('/subscriptions');
  const currentUrl = extractSubscriptionUrl(before.data);

  if (currentUrl !== expectedUrl) {
    const posted = await callMaxApi('/subscriptions', {
      method: 'POST',
      body: {
        url: expectedUrl,
        update_types: DEFAULT_UPDATE_TYPES,
        secret: getWebhookSecret() || undefined,
      },
    });
    if (!posted.ok) {
      return {
        ok: false,
        mode: 'webhook',
        reason: 'SET_WEBHOOK_FAILED',
        expectedUrl,
        currentUrl,
        lastErrorMessage: extractLastError(posted.data),
      };
    }
  }

  const after = await callMaxApi('/subscriptions');
  const currentAfter = extractSubscriptionUrl(after.data);
  return {
    ok: currentAfter === expectedUrl,
    mode: 'webhook',
    expectedUrl,
    currentUrl: currentAfter,
    pendingUpdates: undefined,
    lastErrorMessage: extractLastError(after.data),
  };
}

export function registerMaxUpdateHandler(handler: MaxUpdateHandler) {
  updateHandler = handler;
}

async function startMaxLongPolling(bot: Bot): Promise<{
  ok: boolean;
  mode: 'polling';
  reason?: string;
}> {
  if (!updateHandler) {
    return { ok: false, mode: 'polling', reason: 'UPDATE_HANDLER_NOT_REGISTERED' };
  }

  if (!pollingHandlersAttached) {
    bot.on('message_created', async (ctx: any) => {
      if (!updateHandler) return;
      try {
        await updateHandler(ctx.update);
      } catch (e: any) {
        console.warn('[max-bot] update handler failed:', e?.message || e);
      }
    });
    bot.on('bot_started', async (ctx: any) => {
      if (!updateHandler) return;
      try {
        await updateHandler(ctx.update);
      } catch (e: any) {
        console.warn('[max-bot] update handler failed:', e?.message || e);
      }
    });
    pollingHandlersAttached = true;
  }

  if (pollingLaunched) {
    return { ok: true, mode: 'polling' };
  }

  await bot.start({
    allowedUpdates: DEFAULT_UPDATE_TYPES as any,
  });
  pollingLaunched = true;
  return { ok: true, mode: 'polling' };
}

export async function initializeMaxUpdates(): Promise<{
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
    return startMaxLongPolling(bot);
  }

  if (mode === 'auto' && !isWebhookLikelyPublicAndReachable(expectedWebhookUrl)) {
    return startMaxLongPolling(bot);
  }

  const webhook = await ensureMaxWebhook();
  if (webhook.ok || mode === 'webhook') {
    return webhook;
  }

  return startMaxLongPolling(bot);
}

export async function stopMaxUpdates() {
  if (!pollingLaunched || !cachedBot) return;
  cachedBot.stop();
  pollingLaunched = false;
}

export async function sendMaxPhoneContactRequestMessage(params: {
  chatId: string | number | bigint;
  requestedPhone?: string | null;
}) {
  const bot = getBot();
  if (!bot) return false;

  const userId = toIntId(params.chatId);
  const phoneHint = params.requestedPhone ? ` ${params.requestedPhone}` : '';

  await bot.api.sendMessageToUser(
    userId,
    `Для подтверждения номера${phoneHint} нажмите кнопку ниже и отправьте контакт.`,
    {
      attachments: [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [[{ type: 'request_contact', text: 'Отправить контакт' }]],
          },
        },
      ],
    } as any
  );

  return true;
}

export async function sendMaxInfoMessage(params: {
  chatId: string | number | bigint;
  text: string;
  removeKeyboard?: boolean;
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  disableLinkPreview?: boolean;
}) {
  const bot = getBot();
  if (!bot) return false;

  const userId = toIntId(params.chatId);
  const mode = String(params.parseMode || '').toLowerCase();
  const options: Record<string, any> = {};
  if (mode === 'html') options.format = 'html';
  else if (mode === 'markdown' || mode === 'markdownv2') options.format = 'markdown';
  if (params.disableLinkPreview) options.disable_link_preview = true;

  try {
    await bot.api.sendMessageToUser(userId, params.text, Object.keys(options).length ? options : undefined);
  } catch (error) {
    if (mode !== 'html') throw error;
    // MAX may reject html formatting in some payloads; retry as plain text.
    const fallbackText = htmlToPlainText(params.text);
    await bot.api.sendMessageToUser(
      userId,
      fallbackText || params.text.replace(/<[^>]+>/g, ''),
      params.disableLinkPreview ? { disable_link_preview: true } : undefined
    );
  }
  return true;
}

export async function sendMaxWelcomeMessage(params: {
  chatId: string | number | bigint;
  startParam?: string;
}) {
  const bot = getBot();
  if (!bot) return false;

  const userId = toIntId(params.chatId);
  const appLink = buildMaxMiniAppLink(params.startParam || 'home');
  const company = getCompanyName();
  const logoUrl = getWelcomeLogoUrl();

  const text =
    `👋 <b>Добро пожаловать в ${company}</b>\n` +
    `Откройте приложение по кнопке ниже.`;

  const keyboardAttachments: any[] = [];
  if (appLink) {
    keyboardAttachments.push({
      type: 'inline_keyboard',
      payload: {
        buttons: [[{ type: 'link', text: 'Приложение', url: appLink }]],
      },
    });
  }

  const imageAttachments: any[] = logoUrl
    ? [
        {
          type: 'image',
          payload: { url: logoUrl },
        },
      ]
    : [];

  const attachmentsWithImage = [...imageAttachments, ...keyboardAttachments];
  const attachmentsNoImage = [...keyboardAttachments];

  try {
    await bot.api.sendMessageToUser(
      userId,
      text,
      {
        format: 'html',
        disable_link_preview: true,
        ...(attachmentsWithImage.length ? { attachments: attachmentsWithImage } : {}),
      } as any
    );
  } catch (errWithImage: any) {
    if (imageAttachments.length) {
      console.warn('[max-bot] welcome with image failed, retry without image:', errWithImage?.message || errWithImage);
      try {
        await bot.api.sendMessageToUser(
          userId,
          text,
          {
            format: 'html',
            disable_link_preview: true,
            ...(attachmentsNoImage.length ? { attachments: attachmentsNoImage } : {}),
          } as any
        );
        return true;
      } catch {
        // continue to plain fallback
      }
    }

    const fallback = appLink
      ? `Добро пожаловать в ${company}.\nОткрыть приложение: ${appLink}`
      : `Добро пожаловать в ${company}.`;
    await bot.api.sendMessageToUser(
      userId,
      fallback,
      attachmentsNoImage.length ? ({ attachments: attachmentsNoImage } as any) : undefined
    );
  }

  return true;
}
