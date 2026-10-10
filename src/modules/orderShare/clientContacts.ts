import { z } from 'zod';

export function normalizeContactPhone(value: string): string | null {
  if (!/^[+\d\s().-]+$/.test(value)) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

export function normalizeMessenger(value: string | null | undefined, kind: 'telegram' | 'max'): string | null {
  const raw = (value || '').trim();
  if (!raw) return null;
  const input = kind === 'telegram' && /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(raw)
    ? `https://t.me/${raw.replace(/^@/, '')}` : raw;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    if (kind === 'telegram' && url.hostname === 't.me' && /^\/[A-Za-z][A-Za-z0-9_]{4,31}\/?$/.test(url.pathname)) return url.href.replace(/\/$/, '');
    if (kind === 'max' && url.hostname === 'max.ru' && /^\/(?:u\/)?[A-Za-z0-9_-]{3,200}\/?$/.test(url.pathname)) return url.href.replace(/\/$/, '');
  } catch { /* Invalid URLs must not become public links. */ }
  return null;
}

const messenger = (kind: 'telegram' | 'max') => z.string().trim().max(250).nullable().optional()
  .refine(value => !value || !!normalizeMessenger(value, kind), `Укажите корректную ссылку ${kind === 'telegram' ? 'https://t.me/… или @username' : 'https://max.ru/…'}`)
  .transform(value => normalizeMessenger(value, kind));

export function normalizeWhatsApp(value: string | null | undefined): string | null {
  const raw = (value || '').trim();
  if (!raw) return null;
  const phone = normalizeContactPhone(raw);
  if (phone) return `https://wa.me/${phone.slice(1)}`;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && url.hostname === 'wa.me' && !url.username && !url.password && !url.port && !url.search && !url.hash
      && /^\/[1-9]\d{7,14}\/?$/.test(url.pathname)) return `https://wa.me${url.pathname.replace(/\/$/, '')}`;
  } catch { /* Only official click-to-chat links or phone numbers are accepted. */ }
  return null;
}

export const clientContactsSchema = z.object({
  phones: z.array(z.object({
    label: z.string().trim().max(32).default(''),
    number: z.string().trim().max(40).refine(value => !!normalizeContactPhone(value), 'Проверьте номер телефона').transform(value => normalizeContactPhone(value)!),
  }).strict()).max(5, 'Можно указать не более пяти номеров'),
  telegramUrl: messenger('telegram'),
  maxUrl: messenger('max'),
  whatsappUrl: z.string().trim().max(250).nullable().optional()
    .refine(value => !value || !!normalizeWhatsApp(value), 'Укажите номер WhatsApp или ссылку https://wa.me/…')
    .transform(normalizeWhatsApp),
  email: z.string().trim().max(254).nullable().optional()
    .refine(value => !value || z.email().safeParse(value).success, 'Проверьте адрес электронной почты')
    .transform(value => value || null),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.phones.map(phone => phone.number)).size !== value.phones.length) {
    ctx.addIssue({ code: 'custom', path: ['phones'], message: 'Номера телефонов не должны повторяться' });
  }
});
export type ClientContacts = z.infer<typeof clientContactsSchema>;

/** Older APKs do not send these fields. Omission preserves them; explicit null clears them. */
export function parseClientContactsUpdate(input: unknown, stored: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return clientContactsSchema.safeParse(input);
  const previous = clientContactsSchema.safeParse(stored);
  const merged = { ...input } as Record<string, unknown>;
  for (const field of ['whatsappUrl', 'email'] as const) {
    if (!Object.prototype.hasOwnProperty.call(merged, field)) merged[field] = previous.success ? previous.data[field] : null;
  }
  return clientContactsSchema.safeParse(merged);
}

export function resolveClientContacts(value: unknown, defaultPhone: unknown): ClientContacts {
  const parsed = clientContactsSchema.safeParse(value);
  const settings = parsed.success ? parsed.data : { phones: [], telegramUrl: null, maxUrl: null, whatsappUrl: null, email: null };
  const fallback = defaultPhone == null ? null : normalizeContactPhone(String(defaultPhone));
  return { ...settings, phones: settings.phones.length ? settings.phones : fallback ? [{ label: '', number: fallback }] : [] };
}
