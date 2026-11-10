import { OnecPersonalError } from './config';

/** Classify privately; upstream text can contain queries, paths and credentials.
 * Only server-owned codes and numeric locations may leave this function. */
export function onecQueryFailure(value: unknown, fallback = 'ONEC_TOOL_FAILED'): OnecPersonalError {
  const text = typeof value === 'string' ? value.slice(0, 131072) : '';
  const rules: Array<[RegExp, string]> = [
    [/недостаточно\s+прав|нарушение\s+прав\s+доступа|access\s+denied|insufficient\s+(?:access|permission)/iu, 'ONEC_QUERY_ACCESS_DENIED'],
    [/ожидается\s+(?:имя|идентификатор)|expected\s+(?:identifier|name)/iu, 'ONEC_QUERY_EXPECTED_IDENTIFIER'],
    [/поле\s+не\s+найдено|field\s+(?:not\s+found|does\s+not\s+exist)/iu, 'ONEC_QUERY_FIELD_UNKNOWN'],
    [/таблица\s+не\s+найдена|table\s+(?:not\s+found|does\s+not\s+exist)/iu, 'ONEC_QUERY_TABLE_UNKNOWN'],
    [/не\s+задано\s+значение\s+параметра|параметр\s+не\s+(?:задан|установлен)|parameter\s+(?:not\s+set|missing)/iu, 'ONEC_QUERY_PARAMETER_MISSING'],
    [/несовместим[\p{L}]*\s+тип|неверн[\p{L}]*\s+тип|тип[\p{L}\s]{0,40}не\s+может\s+быть|type\s+mismatch/iu, 'ONEC_QUERY_TYPE_MISMATCH'],
    [/синтаксическ[\p{L}]*\s+ошибк|неверн[\p{L}]*\s+параметр[\p{L}]*\s+(?:в\s+операции|функции)|syntax\s+error/iu, 'ONEC_QUERY_SYNTAX'],
  ];
  const code = rules.find(([pattern]) => pattern.test(text))?.[1] ?? fallback;
  const match = text.match(/\{\((\d{1,5}),\s*(\d{1,5})\)\}/u);
  const diagnostic = match && code !== fallback ? { line: Number(match[1]), column: Number(match[2]) } : undefined;
  return new OnecPersonalError(code, code === 'ONEC_RPC_ERROR' ? 502 : 422, diagnostic);
}
