type Conditions = {
  daily?: true;
  negativeStock?: true;
  time?: string;
  timeZone?: string;
  warehouse?: string;
  metric?: 'inStock' | 'available';
};

type Reply = {text: string; state: {schedulePending?: Conditions; scheduleDraft?: Required<Omit<Conditions,'daily'|'negativeStock'>>}};
const recurrence = /кажд(?:ый день|ое утро|ый вечер|ую ночь|ые сутки)|ежедневн|раз в (?:день|сутки)/iu;
const creation = /(?:созда(?:й|ть|йте)|сдела(?:й|ть|йте)|добав(?:ь|ить|ьте)|настро(?:й|ить|йте))\s+(?:мне\s+)?(?:новое\s+)?(?:регламентное\s+)?задание/iu;
const shortage = /отрицательн|ниже\s*(?:нуля|0)|меньше\s*(?:нуля|0)|минусов|в минус/iu;
const shorthand = /^(?:в\s+\d|\d{1,2}:|кажд|ежеднев|отрицательн|проверяй|по всем склад|на склад|по моск|раз в день)/iu;

export function scheduleReply(text: string, clientZone: string | undefined, previous?: Conditions): Reply | undefined {
  const phrase = text.trim().replace(/ё/giu,'е');
  if (!phrase || phrase.length > 3500 || /(?:не надо|не нужно|не создавай|отмени|отменить)\s/iu.test(phrase)) return;
  const stock = /остат(?:к|ок)/iu.test(phrase) && shortage.test(phrase);
  if (!creation.test(phrase) && !(recurrence.test(phrase) && stock && /присыл|пришл|провер|сообщ|уведом|отправ|показыв|напомин/iu.test(phrase)) && !(previous && shorthand.test(phrase))) return;
  const c: Conditions = {...previous};
  if (stock) c.negativeStock = true;
  if (recurrence.test(phrase)) c.daily = true;
  const ask = (question: string): Reply => ({text:question,state:{schedulePending:c}});
  if (/будн|выходн|еженедель|по понедельник|по вторник|по средам|по четвергам|по пятницам|кроме|каждую неделю|ежемесячн/iu.test(phrase)) {
    delete c.daily;
    return ask('Доступна ежедневная проверка. Напишите, подходит ли она, и укажите время.');
  }
  const times = [...phrase.matchAll(/(?:^|[^\d:])(\d{1,2}):(\d{2})(?!\d)/gu)];
  const hour = /(?:^|\s)в\s+(\d{1,2})(?![\d:])/iu.exec(phrase);
  if (times.length > 1 || times.length && (+times[0][1]>23 || +times[0][2]>59) || hour && +hour[1]>23) {
    delete c.time;
    return ask('Укажите одно время в формате ЧЧ:ММ, например 12:00.');
  }
  if (times[0]) c.time=times[0][1].padStart(2,'0')+':'+times[0][2];
  else if (hour) c.time=hour[1].padStart(2,'0')+':00';
  const zone = phrase.match(/\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_\-+/]+/u)?.[0] ||
    (/моск(?:ве|овск)|\bMSK\b|мск/iu.test(phrase)?'Europe/Moscow':/новосибирск/iu.test(phrase)?'Asia/Novosibirsk':undefined);
  try { c.timeZone = new Intl.DateTimeFormat('en',{timeZone:zone || c.timeZone || clientZone || 'Asia/Novosibirsk'}).resolvedOptions().timeZone; }
  catch { return ask('Укажите часовой пояс, например Europe/Moscow.'); }
  if (/доступн|резерв/iu.test(phrase)) c.metric='available';
  const named = /склад(?:у|е|а)?\s+[«"]([^»"\n]{1,120})[»"]/iu.exec(phrase);
  if (named) c.warehouse = named[1].trim();
  else if (/вс(?:е|ех|ем|им)\s+склад/iu.test(phrase)) c.warehouse='all';
  else if (/склад/iu.test(phrase) && !/складск/iu.test(phrase)) return ask('Для проверки одного склада укажите его точное название в кавычках, например на складе «Основной», или напишите «по всем складам».');
  if (!c.negativeStock) return ask('Какое задание создать? Можно каждый день присылать отчёт, если появились отрицательные остатки. Укажите условие и время.');
  if (!c.daily || !c.time) return ask('Когда проверять отрицательные остатки? Например, «каждый день в 12:00».');
  return {text:'Проверьте условия и нажмите «Включить задание».',state:{scheduleDraft:{time:c.time,timeZone:c.timeZone,warehouse:c.warehouse || 'all',metric:c.metric || 'inStock'}}};
}

export async function prepareScheduleReply(seed: unknown, previousState: (before: number)=>Promise<unknown>): Promise<Reply|undefined> {
  const context = seed as {inputs?: {text?:string;sequence?:number}[];clientContext?:{timeZone?:string}} | null;
  const inputs = Array.isArray(seed) ? seed : context?.inputs;
  const latest = inputs?.[inputs.length-1];
  if (typeof latest?.text !== 'string') return;
  const zone = context?.clientContext?.timeZone;
  const direct = scheduleReply(latest.text, zone);
  if (direct || !shorthand.test(latest.text.trim()) || !Number.isInteger(latest.sequence)) return direct;
  const prior = await previousState(latest.sequence);
  if (!prior || typeof prior !== 'object' || !('schedulePending' in prior) || !prior.schedulePending || typeof prior.schedulePending!=='object') return;
  return scheduleReply(latest.text, zone, prior.schedulePending as Conditions);
}
