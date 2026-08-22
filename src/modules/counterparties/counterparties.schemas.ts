import { z } from 'zod';

const onecGuid = z.string().trim().uuid('Некорректный GUID 1С');

export const counterpartyCardParamsSchema = z.object({
  guid: onecGuid,
});

export const counterpartyCardQuerySchema = z.object({
  organizationGuid: onecGuid.optional(),
  preset: z.enum(['week', 'month', 'quarter', 'halfYear', 'year', 'custom']).default('month'),
  periodFrom: z.iso.date().optional(),
  periodTo: z.iso.date().optional(),
  refresh: z.preprocess(
    (value) => value === true || value === 'true' || value === '1',
    z.boolean()
  ).default(false),
}).superRefine((query, context) => {
  if (query.preset !== 'custom') return;
  if (!query.periodFrom) {
    context.addIssue({ code: 'custom', path: ['periodFrom'], message: 'Укажите начало произвольного периода.' });
  }
  if (!query.periodTo) {
    context.addIssue({ code: 'custom', path: ['periodTo'], message: 'Укажите окончание произвольного периода.' });
  }
  if (query.periodFrom && query.periodTo && query.periodFrom > query.periodTo) {
    context.addIssue({ code: 'custom', path: ['periodTo'], message: 'Дата окончания не может быть раньше даты начала.' });
  }
});

export const counterpartyFinancialDocumentsQuerySchema = z.object({
  organizationGuid: onecGuid,
  preset: z.enum(['week', 'month', 'quarter', 'halfYear', 'year', 'custom']).default('month'),
  periodFrom: z.iso.date().optional(),
  periodTo: z.iso.date().optional(),
  status: z.enum(['OVERDUE', 'EXPECTED', 'AWAITING_SHIPMENT', 'PAID']).optional(),
  cursor: z.string().trim().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).superRefine((query, context) => {
  if (query.preset !== 'custom') return;
  if (!query.periodFrom) context.addIssue({ code: 'custom', path: ['periodFrom'], message: 'Укажите начало периода.' });
  if (!query.periodTo) context.addIssue({ code: 'custom', path: ['periodTo'], message: 'Укажите окончание периода.' });
  if (query.periodFrom && query.periodTo && query.periodFrom > query.periodTo) {
    context.addIssue({ code: 'custom', path: ['periodTo'], message: 'Дата окончания не может быть раньше даты начала.' });
  }
});

export type CounterpartyCardParams = z.infer<typeof counterpartyCardParamsSchema>;
export type CounterpartyCardQuery = z.infer<typeof counterpartyCardQuerySchema>;
export type CounterpartyFinancialDocumentsQuery = z.infer<typeof counterpartyFinancialDocumentsQuerySchema>;
