// src/validation/appeals.schema.ts
import { z } from 'zod';
import { AppealPriority, AppealStatus } from '@prisma/client';

/**
 * Универсальные препроцессоры под совместимость с разными версиями Zod:
 *  - zNumberId: строку "12" -> 12, валидируем как положительное целое
 *  - zTrimmed: обрезает пробелы у строк
 *  - zOptionalNonEmptyString: "" -> undefined, "  текст " -> "текст"
 *  - zISODateString: "" -> undefined, иначе проверяем, что Date.parse не NaN
 */

export const zNumberId = z.preprocess((v) => {
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}, z.number().int().positive());

export const zTrimmed = z.preprocess((v) => {
  if (typeof v === 'string') return v.trim();
  return v;
}, z.string());

export const zOptionalNonEmptyString = z.preprocess((v) => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}, z.string().optional());

export const zISODateString = z.preprocess((v) => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}, z
  .string()
  .optional()
  .refine((val) => (val ? !Number.isNaN(Date.parse(val)) : true), {
    message: 'Некорректная дата',
  }));

/** Скоупы для листинга/экспорта */
export const ScopeEnum = z.enum(['my', 'department', 'assigned']);

/* =========================
 *   СХЕМЫ ДЛЯ /appeals
 * ========================= */

/** POST /appeals — тело запроса */
export const CreateAppealBodySchema = z.object({
  toDepartmentId: zNumberId, // принимает "12" и 12
  title: zOptionalNonEmptyString,
  text: zTrimmed.refine((s) => s.length > 0, { message: 'Поле text обязательно' }),
  priority: z.nativeEnum(AppealPriority).optional(),
  deadline: zISODateString, // ISO string либо undefined
});
export type CreateAppealBody = z.infer<typeof CreateAppealBodySchema>;

/** GET /appeals — query */
export const ListQuerySchema = z.object({
  scope: ScopeEnum.default('my'),
  limit: z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(1).max(100)).default(20),
  offset: z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(0)).default(0),
  status: z.nativeEnum(AppealStatus).optional(),
  priority: z.nativeEnum(AppealPriority).optional(),
});

/** GET /appeals/:id — params */
export const IdParamSchema = z.object({
  id: zNumberId,
});

/* ==============================
 *   /appeals/:id/assign (PUT)
 * ============================== */
export const AssignBodySchema = z.object({
  assigneeIds: z.array(zNumberId).min(1, 'assigneeIds должен быть непустым массивом'),
});

/* ==============================
 *   /appeals/:id/status (PUT)
 * ============================== */
export const StatusBodySchema = z.object({
  status: z.nativeEnum(AppealStatus),
});

/* ========================================
 *   /appeals/:id/messages (POST, multipart)
 * ======================================== */
export const AddMessageBodySchema = z.object({
  // текст опционален (можно отправить только файлы)
  text: zOptionalNonEmptyString,
});

/* ======================================
 *   /appeals/:id/watchers (PUT)
 * ====================================== */
export const WatchersBodySchema = z.object({
  // допускаем и пустой массив — чтобы «очистить наблюдателей»
  watcherIds: z.array(zNumberId).default([]),
});

/* ==============================================
 *   /appeals/messages/:messageId (PUT/DELETE)
 * ============================================== */
export const MessageIdParamSchema = z.object({
  messageId: zNumberId,
});

// Для редактирования сообщения текст обязателен
export const EditMessageBodySchema = z.object({
  text: zTrimmed.refine((s) => s.length > 0, { message: 'Поле text обязательно' }),
});

/* ===============================
 *   /appeals/export (GET)
 * =============================== */
export const ExportQuerySchema = z.object({
  scope: ScopeEnum.default('my'),
  status: z.nativeEnum(AppealStatus).optional(),
  priority: z.nativeEnum(AppealPriority).optional(),
  fromDate: zISODateString,
  toDate: zISODateString,
});
export type ExportQuery = z.infer<typeof ExportQuerySchema>;
