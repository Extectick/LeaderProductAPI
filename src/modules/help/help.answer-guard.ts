import { inspectHelpAnswer } from './help.answer-policy';

type Messages = ReadonlyArray<{ role: string; text: string }>;
type Generated = {
  decision: 'answer' | 'clarify' | 'handoff'; text: string;
  sources: Array<{documentId:string;versionId:string;revision:number;title:string;path:string;sourceUrl:string;excerpt?:string}>;
  questions?: Array<{id:string;header:string;question:string;options:Array<{label:string;description:string}>;multiSelect:boolean}>;
  suggestions?: string[]; files?: Array<{name:string;content:string}>; officeFiles?:import('./help.office-contract').HelpOfficeFile[];
  htmlFiles?:import('./help.html').HelpHtmlFile[];
  responseId:string; model:string; usage:{inputTokens:number;outputTokens:number;totalTokens:number;reasoningTokens?:number}|null;
};
type PublicProgress = { draftText?: string; activity?: { kind: string; text?: string }; flush?: boolean };
export const HELP_ANSWER_GUARD_VERSION = 'diagnostic-first-v1';
const confirmIT = 'Чтобы вызвать IT-специалиста, нажмите кнопку под ответом и подтвердите вызов.';

/** Keep the diagnostic reason. A model cannot register or announce a transfer. */
export function helpHandoffText(text: string,options:{explainAction?:boolean}={}) {
  let removedAction=false;
  const parts = text.trim().split(/(?<=[.!?])\s+|\n+/u).filter(part => !/(?:обращени[ея]|заявк[аиу]|запрос).{0,70}(?:передан|отправлен|направлен)|(?:передал[аи]?|отправил[аи]?|вызвал[аи]?|подключил[аи]?).{0,60}(?:специалист|\bIT\b|\bИТ\b)|специалист.{0,50}(?:подключился|подключилась|уже подключ|назначен)/iu.test(part)).map(part=>{
    const it=/(?:IT|ИТ|айти|специалист)/iu.test(part),button=/нажм(?:ите|и)|(?:использу(?:йте|й)|выбер(?:ите|и)|нажат[ьи]|кликн(?:ите|и)).{0,35}кнопк|(?:нужно|можно|следует).{0,20}вызвать.{0,40}кнопк/iu.test(part);
    if(button&&(it||/вызов|подтверд.{0,30}передач/iu.test(part))){
      removedAction=true;
      const start=part.search(/(?:чтобы\s+(?:вызвать|подключить|передать)|для\s+(?:вызова|подключения|передачи)|(?:нужно|можно|следует)\s+вызвать|нажм(?:ите|и))/iu);
      // Keep a diagnostic clause before the UI instruction, rather than
      // discarding the reason together with a mixed sentence.
      const prefix=start>0?part.slice(0,start).replace(/[,;:\s–—-]*(?:поэтому|тогда)?[,;:\s–—-]*$/iu,'').trim():'';
      const suffix=part.match(/[,;]\s*(?:потому\s+что|так\s+как|поскольку)\s+(.+)$/iu)?.[1]?.trim();
      return [prefix,suffix].filter(Boolean).join(' ');
    }
    if(removedAction&&/^(?:затем\s+|после\s+этого\s+)?подтверд(?:ите|и)\s+(?:вызов|передачу|подключение|его)/iu.test(part))return '';
    return part;
  }).filter(Boolean);
  const reason = parts.join(' ').slice(0, 11500).trim() || 'Для продолжения проверки можно обратиться к IT-специалисту.';
  return options.explainAction===false?reason:`${reason}\n\n${confirmIT}`;
}

/** Screen every public field, including file contents before the upload stage. */
export function guardHelpGeneratedAnswer(answer: Generated, messages: Messages, hasAttachments = false): Generated {
  const text = [answer.text, ...(answer.suggestions || []), ...(answer.questions || []).flatMap(question => [question.question, question.header,
    ...question.options.flatMap(option => [option.label, option.description || ''])]), ...(answer.files || []).flatMap(file => [file.name, file.content]), ...(answer.officeFiles||[]).flatMap(file=>[file.name,file.reviewText||'']),...(answer.htmlFiles||[]).flatMap(file=>[file.name,file.reviewText])];
  const inspections = text.map(value => inspectHelpAnswer(value, { phase: 'final', messages, hasAttachments }));
  const unsafe = inspections.find(value => !value.safe && value.code !== 'HELP_ANSWER_UNGROUNDED_DIAGNOSTICS') || inspections.find(value => !value.safe);
  if (!unsafe) return answer;
  if (unsafe.code === 'HELP_ANSWER_UNGROUNDED_DIAGNOSTICS') return { ...answer, decision: 'clarify', text: 'Здравствуйте! С чем нужна помощь?', sources: [], files: [], officeFiles: [], htmlFiles: [], suggestions: [],
    questions: [{ id: 'help-request', header: 'Задача', question: 'С чем нужна помощь?', options: [], multiSelect: false }] };
  return { ...answer, decision: 'handoff', text: 'Для таких изменений нужна проверка IT-специалистом. Можно продолжить диагностику без изменения защиты, прав доступа и конфигурации базы.', sources: [], files: [], officeFiles: [], htmlFiles: [], questions: [], suggestions: [] };
}

/** The lease/source/proof fences remain owned by the original progress writer. */
export function guardHelpAIProgress<T extends PublicProgress>(progress: ((update: T) => Promise<void>) | undefined, messages: Messages, hasAttachments: boolean | (() => boolean) = false): ((update: T) => Promise<void>) | undefined {
  if (!progress) return undefined;
  let lastSafeDraft = '';
  return async update => {
    let checked = update;
    const options = { phase: 'draft' as const, messages, hasAttachments: typeof hasAttachments === 'function' ? hasAttachments() : hasAttachments };
    if (typeof update.draftText === 'string') {
      const inspection = inspectHelpAnswer(update.draftText, options);
      if (!inspection.safe) {
        checked = { ...checked, draftText: '', flush: true };
        // A partial word can be ambiguous without invalidating the already
        // published prefix. Hold only that new suffix; still run every fence.
        // Corrections, explicit withdrawals and confirmed blocks must clear.
        if (inspection.action === 'hold' && lastSafeDraft && update.draftText.startsWith(lastSafeDraft)
          && inspectHelpAnswer(lastSafeDraft, options).safe) delete checked.draftText;
      }
    }
    if (update.activity?.kind === 'analysis' && update.activity.text && !inspectHelpAnswer(update.activity.text, options).safe) {
      checked = { ...checked, activity: { ...update.activity, text: 'Проверяю безопасный порядок диагностики.' }, flush: true };
    }
    await progress(checked);
    if (typeof checked.draftText === 'string') lastSafeDraft = checked.draftText;
  };
}
