import { z } from 'zod';

// PostgreSQL Int cursors are sequences/IDs, never array offsets. One direction per
// request makes overlapping prefetches and distant message jumps unambiguous.
const sequence = z.coerce.number().int().positive().max(2147483647);
export const helpHistoryQuery = z.object({
  before: sequence.optional(),
  after: sequence.optional(),
  around: sequence.optional(),
  aroundMessageId: sequence.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict().refine(value => [value.before, value.after, value.around, value.aroundMessageId].filter(v => v !== undefined).length <= 1, {
  message: 'Укажите только одно направление загрузки',
});

export const helpSearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  before: sequence.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

const dateBoundary = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Некорректная дата');
export const helpDateQuery = z.object({ from: dateBoundary, to: dateBoundary }).strict().refine(value => {
  const duration = Date.parse(value.to) - Date.parse(value.from);
  return duration > 0 && duration <= 48 * 60 * 60 * 1000;
}, { path: ['to'], message: 'Укажите положительный диапазон дат не длиннее 48 часов' });

export const helpSyncQuery = z.object({
  after: z.coerce.number().int().nonnegative().max(2147483647).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(200),
}).strict();

export type HelpHistoryQuery = z.infer<typeof helpHistoryQuery>;
export type HelpSearchQuery = z.infer<typeof helpSearchQuery>;
export type HelpDateQuery = z.infer<typeof helpDateQuery>;
export type HelpSyncQuery = z.infer<typeof helpSyncQuery>;
