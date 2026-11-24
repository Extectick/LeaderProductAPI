import {OnecPersonalError} from '../onec-personal/config';
import {type OnecProof, userMcpCall} from '../onec-personal/service';

export type ScheduleStockMetric = 'inStock' | 'available';
export type ScheduleStockRow = {product: string; warehouse: string; quantity: number};
export type ScheduleStockResult = {rows: ScheduleStockRow[]; truncated: boolean; proof: OnecProof};
type ScheduleMcp = (userId: number, base: string, tool: string, args: unknown, signal?: AbortSignal) =>
  Promise<{text?: string; proof: OnecProof}>;
export class ScheduleStockError extends Error {}

const baseKey = 'torg2026';
const rowLimit = 100;

export function scheduleStockQuery(metric: ScheduleStockMetric, namedWarehouse: boolean) {
  // Aggregate physical stock and reserves by references before testing the sign.
  // A reserve-only product/warehouse pair must also participate in the result.
  const warehouseFilter = namedWarehouse ? ' И Баланс.Склад.Наименование = &Склад' : '';
  const physical = `ВЫБРАТЬ Баланс.Номенклатура, Баланс.Склад, Баланс.ВНаличииОстаток КАК Количество
    ИЗ РегистрНакопления.ТоварыНаСкладах.Остатки(, Назначение = ЗНАЧЕНИЕ(Справочник.Назначения.ПустаяСсылка)) КАК Баланс
    ГДЕ Баланс.ВНаличииОстаток <> 0${warehouseFilter}`;
  const parts = [physical];
  if (metric === 'available') {
    const stockStates = ['ОстатокНаСкладе', 'ОжидаемоеПоступление', 'ОбеспеченНаСкладе', 'ОбеспеченКДате', 'Обеспечить', 'ВРезерве']
      .map(state => `ЗНАЧЕНИЕ(Перечисление.РаспределениеЗапасовСостояния.${state})`).join(', ');
    parts.push(
      `ВЫБРАТЬ Баланс.Номенклатура, Баланс.Склад, -Баланс.Зарезервировано
       ИЗ РегистрСведений.РаспределениеЗапасов КАК Баланс
       ГДЕ Баланс.Состояние В (${stockStates}) И Баланс.Склад ССЫЛКА Справочник.Склады
         И Баланс.Назначение = ЗНАЧЕНИЕ(Справочник.Назначения.ПустаяСсылка)
         И Баланс.Зарезервировано <> 0${warehouseFilter}`,
      `ВЫБРАТЬ Баланс.Номенклатура, Баланс.Склад, -Баланс.КоличествоОстаток
       ИЗ РегистрНакопления.РезервыМенеджеров.Остатки КАК Баланс
       ГДЕ Баланс.КоличествоОстаток <> 0${warehouseFilter}`,
    );
  }
  return `ВЫБРАТЬ РАЗРЕШЕННЫЕ ПЕРВЫЕ ${rowLimit + 1}
    Итог.Номенклатура.Наименование КАК Товар, Итог.Склад.Наименование КАК ИмяСклада,
    СУММА(Итог.Количество) КАК Количество
    ИЗ (${parts.join('\nОБЪЕДИНИТЬ ВСЕ\n')}) КАК Итог
    СГРУППИРОВАТЬ ПО Итог.Номенклатура, Итог.Склад
    ИМЕЮЩИЕ СУММА(Итог.Количество) < 0
    УПОРЯДОЧИТЬ ПО Количество, ИмяСклада, Товар`;
}

function parsePage(text: string | undefined, max: number): {data: Record<string, unknown>[]; truncated: boolean} {
  let value;
  try { value = JSON.parse(text ?? ''); } catch { throw new OnecPersonalError('ONEC_PROTOCOL_ERROR'); }
  if (value?.success !== true || !Array.isArray(value.data) || value.rowCount !== value.data.length || value.data.length > max ||
      value.data.some((item: unknown) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new OnecPersonalError('ONEC_PROTOCOL_ERROR');
  }
  return {data: value.data, truncated: value.truncated === true || (value.responseSizeReduced === true && value.rowCount >= value.pageLimitApplied)};
}

export async function readScheduleStock(userId: number, metric: ScheduleStockMetric, warehouse: string, signal: AbortSignal, call: ScheduleMcp = userMcpCall): Promise<ScheduleStockResult> {
  const namedWarehouse = warehouse !== 'all';
  const parameters = namedWarehouse ? {Склад: warehouse} : undefined;
  let warehouseProof: OnecProof | undefined;
  if (namedWarehouse) {
    const lookup = await call(userId, baseKey, 'execute_query', {
      query: 'ВЫБРАТЬ РАЗРЕШЕННЫЕ ПЕРВЫЕ 2 С.Наименование ИЗ Справочник.Склады КАК С ГДЕ НЕ С.ПометкаУдаления И НЕ С.ЭтоГруппа И С.Наименование = &Склад',
      parameters, maxRows: 2,
    }, signal);
    warehouseProof = lookup.proof;
    const page = parsePage(lookup.text, 2);
    if (!page.data.length) throw new ScheduleStockError('Склад с таким названием не найден среди доступных вам в 1С.');
    if (page.data.length !== 1 || page.truncated) throw new ScheduleStockError('В 1С несколько складов с таким названием. Уточните склад в задании.');
  }
  const reply = await call(userId, baseKey, 'execute_query', {query: scheduleStockQuery(metric, namedWarehouse), parameters, maxRows: rowLimit + 1}, signal);
  if (warehouseProof && (warehouseProof.revision !== reply.proof.revision || warehouseProof.binding !== reply.proof.binding)) {
    throw new OnecPersonalError('ONEC_AUTH_REQUIRED');
  }
  const page = parsePage(reply.text, rowLimit + 1);
  if (page.truncated && !page.data.length) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR');
  const rows = page.data.slice(0, rowLimit).map(item => {
    const {Товар: product, ИмяСклада: warehouse, Количество: quantity} = item;
    if (typeof product !== 'string' || !product.trim() || typeof warehouse !== 'string' || !warehouse.trim() ||
        typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity >= 0) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR');
    return {product, warehouse, quantity};
  });
  return {rows, truncated: page.truncated || page.data.length > rowLimit, proof: reply.proof};
}
