/** Require an actual first check for explicit live-data requests, not general advice. */
function classifyOnecRead(messages: Array<{ role: string; text: string }>): 'data' | 'check' | false {
  const users = messages.filter(m => m.role === 'user').map(m => m.text.toLowerCase().replace(/ё/g, 'е').trim());
  for (let i = users.length - 1; i >= 0; i--) {
    const text = users[i];
    const explicitOnec = /(?:1[сc]|mcp)/u.test(text);
    const action = /проверь|проверить|посмотр|покаж|найд|получ|прочит|выполн|вывед|сколько|последн|како[ейя]/u.test(text);
    if (/^(?:как|что такое|что значит|объясни|расскажи|инструкция)(?:\s|[?:,.]|$)/u.test(text)) return false;
    if (explicitOnec && action) return /приобрет|поступлен|приходн|остат(?:ок|ки)|закуп|заказ|продаж|накладн|склад|товар/u.test(text) ? 'data' : 'check';
    if (/сотрудник|должност|обязанност|(?:ваш|мой|каком) отдел|(?:задай|задайте).*вопрос|что.*умеешь/u.test(text)) return false;
    if (action && /приобрет|поступлен|приходн|остат(?:ок|ки)|закуп|заказ|продаж|накладн|склад|товар/u.test(text)) return 'data';
    // Short answers and form replies continue the previous request. A new topic does not.
    if (/^(?:да|нет|повтори|проверь (?:еще|снова)|нужна помощь|за последн|последний документ|ответ:|склад\s|ответхранение\s|этот склад|этот документ|не ордерн|неордерн|я уже (?:дал|указал|выбрал))/u.test(text) || text.includes('\nответ:')) continue;
    return false;
  }
  return false;
}

export const requiresOnecRead = (messages: Array<{ role: string; text: string }>) => !!classifyOnecRead(messages);
export const requiresOnecBusinessRead = (messages: Array<{ role: string; text: string }>) => classifyOnecRead(messages) === 'data';
/** Technical naming and renewed read consent are not useful business clarifications. */
export function requiresOnecLookupBeforeClarify(text: string) {
  return /подтверд|подтвержден|точн(?:ое|ое название|ое наименование).*?(?:документ|склад)|техническ.*(?:имя|назван)|имя.*метаданн|(?:како[йе]|выберите).{0,30}(?:вид|тип).{0,30}документ/iu.test(text);
}

/** Structured replies may quote the bot's guessed technical name; prefer the actual business request. */
export function preferredWarehouseTool(messages: Array<{ role: string; text: string }>) {
  if (!requiresOnecRead(messages)) return undefined;
  for (const message of messages.filter(m => m.role === 'user').reverse()) {
    const text = message.text.toLowerCase().replace(/ё/g, 'е');
    if (/\nответ:/u.test(text) || /^(?:нужна помощь|да|нет|повтори|за последн)/u.test(text)) continue;
    if (!/последн/u.test(text) || !/склад/u.test(text)) continue;
    if (/приобрет|закуп/u.test(text) && !/не приобрет|не закуп/u.test(text)) return 'onec_find_latest_purchase';
    if (/приходн.*ордер/u.test(text)) return 'onec_find_latest_order';
    if (/поступлен/u.test(text)) return 'onec_find_latest_receipt';
  }
  return undefined;
}

/** Keep the employee's own warehouse words; the model must not silently select a candidate. */
export function warehouseTextForRequest(messages: Array<{ role: string; text: string }>) {
  if (!requiresOnecRead(messages)) return undefined;
  for (const message of messages.filter(m => m.role === 'user').reverse()) {
    const text = message.text.trim();
    const form = text.split(/\nОтвет:\s*/iu);
    if (form.length > 1) {
      const answer = form[1].trim();
      if (/склад/iu.test(form[0]) && !/период|подтверд/iu.test(form[0]) && !/^(?:да|нет|последний|период|я (?:уже|же)|уже |этот )/iu.test(answer)) return answer.slice(0, 160);
      continue;
    }
    if (/^(?:склад|ответхранение)\s+/iu.test(text)) return text.slice(0, 160);
    const found = text.match(/(?:по складу|на складе|для склада|со склада)\s+(?:[«"]([^»"]+)[»"]|(.+))/iu);
    const value = found?.[1] || found?.[2]?.split(/\s+(?:за|с|до|в период)\s+/iu)[0];
    if (value) return value.replace(/[?.,!]+$/u, '').trim().slice(0, 160);
  }
  return undefined;
}
