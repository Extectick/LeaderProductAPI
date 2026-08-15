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
    context.addIssue({ code: 'custom', path: ['periodFrom'], message: 'Р”Р»СЏ РїСЂРѕРёР·РІРѕР»СЊРЅРѕРіРѕ РїРµСЂРёРѕРґР° СѓРєР°Р¶РёС‚Рµ РЅР°С‡Р°Р»Рѕ.' });
  }
  if (!query.periodTo) {
    context.addIssue({ code: 'custom', path: ['periodTo'], message: 'Р”Р»СЏ РїСЂРѕРёР·РІРѕР»СЊРЅРѕРіРѕ РїРµСЂРёРѕРґР° СѓРєР°Р¶РёС‚Рµ РѕРєРѕРЅС‡Р°РЅРёРµ.' });
  }
  if (query.periodFrom && query.periodTo && query.periodFrom > query.periodTo) {
    context.addIssue({ code: 'custom', path: ['periodTo'], message: 'Р”Р°С‚Р° РѕРєРѕРЅС‡Р°РЅРёСЏ РЅРµ РјРѕР¶РµС‚ Р±С‹С‚СЊ СЂР°РЅСЊС€Рµ РґР°С‚С‹ РЅР°С‡Р°Р»Р°.' });
  }
});

export type CounterpartyCardParams = z.infer<typeof counterpartyCardParamsSchema>;
export type CounterpartyCardQuery = z.infer<typeof counterpartyCardQuerySchema>;
