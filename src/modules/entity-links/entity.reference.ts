import { normalizeEntityTarget, type EntityValue } from './entity.contract';

const metadataPrefixes: Record<string, string> = {
  'Справочник':'Catalogs', 'СправочникСсылка':'Catalogs', 'CatalogRef':'Catalogs',
  'Документ':'Documents', 'ДокументСсылка':'Documents', 'DocumentRef':'Documents',
  'БизнесПроцесс':'BusinessProcesses', 'БизнесПроцессСсылка':'BusinessProcesses', 'BusinessProcessRef':'BusinessProcesses',
  'Задача':'Tasks', 'ЗадачаСсылка':'Tasks', 'TaskRef':'Tasks',
  'ПланОбмена':'ExchangePlans', 'ПланОбменаСсылка':'ExchangePlans', 'ExchangePlanRef':'ExchangePlans',
  'ПланВидовХарактеристик':'ChartsOfCharacteristicTypes', 'ПланВидовХарактеристикСсылка':'ChartsOfCharacteristicTypes', 'ChartOfCharacteristicTypesRef':'ChartsOfCharacteristicTypes',
  'ПланСчетов':'ChartsOfAccounts', 'ПланСчетовСсылка':'ChartsOfAccounts', 'ChartOfAccountsRef':'ChartsOfAccounts',
  'ПланВидовРасчета':'ChartsOfCalculationTypes', 'ПланВидовРасчетаСсылка':'ChartsOfCalculationTypes', 'ChartOfCalculationTypesRef':'ChartsOfCalculationTypes',
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A GUID alone, a presentation and an e1cib navigation URL never establish metadata identity. */
export function onecReferenceValue(value: unknown, baseKey: string): Extract<EntityValue, object> | null {
  if (!object(value)) return null;
  let metaType: unknown = value.metaType;
  let name: unknown = value.name;
  const qualified = typeof value.metadata === 'string' ? value.metadata : typeof value.type === 'string' ? value.type : undefined;
  if (qualified) {
    const match = /^([\p{L}_][\p{L}\p{N}_]*)\.([\p{L}_][\p{L}\p{N}_]{0,99})$/u.exec(qualified);
    if (match && metadataPrefixes[match[1]]) { metaType = metadataPrefixes[match[1]]; name = match[2]; }
    // Unknown explicit metadata must not fall through to unrelated name/type fields.
    else if (typeof value.metadata === 'string') return null;
  }
  const guid = typeof value.guid === 'string' ? value.guid : typeof value.value === 'string' ? value.value : undefined;
  const target = normalizeEntityTarget({v:1, source:'onec', baseKey, metaType, name, guid});
  if (!target) return null;
  const label = [value.presentation, value.Представление, value.displayName].find(item => typeof item === 'string' && item.trim());
  return {label: typeof label === 'string' ? label.slice(0, 500) : target.source === 'onec' ? target.name : target.kind==='user'?target.id:target.guid, target};
}
