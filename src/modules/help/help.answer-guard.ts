import { inspectHelpAnswer } from './help.answer-policy';

type Messages = ReadonlyArray<{ role: string; text: string }>;
type Generated = {
  decision: 'answer' | 'clarify' | 'handoff'; text: string;
  sources: Array<{documentId:string;versionId:string;revision:number;title:string;path:string;sourceUrl:string;excerpt?:string}>;
  questions?: Array<{id:string;header:string;question:string;options:Array<{label:string;description:string}>;multiSelect:boolean}>;
  suggestions?: string[]; files?: Array<{name:string;content:string}>;
  responseId:string; model:string; usage:{inputTokens:number;outputTokens:number;totalTokens:number;reasoningTokens?:number}|null;
};
type PublicProgress = { draftText?: string; activity?: { kind: string; text?: string }; flush?: boolean };
export const HELP_ANSWER_GUARD_VERSION = 'diagnostic-first-v1';
const confirmIT = 'Чтобы вызвать IT-специалиста, нажмите кнопку под ответом и подтвердите вызов.';

/** Keep the diagnostic reason. A model cannot register or announce a transfer. */
export function helpHandoffText(text: string) {
  const parts = text.trim().split(/(?<=[.!?])\s+|\n+/u).filter(part => !/(?:обращени[ея]|заявк[аиу]|запрос).{0,70}(?:передан|отправлен|направлен)|(?:передал[аи]?|отправил[аи]?|вызвал[аи]?|подключил[аи]?).{0,60}(?:специалист|\bIT\b|\bИТ\b)|специалист.{0,50}(?:подключился|подключилась|уже подключ|назначен)/iu.test(part));
  const reason = parts.join(' ').slice(0, 11500).trim() || 'Для продолжения проверки можно обратиться к IT-специалисту.';
  return reason.includes(confirmIT) ? reason : `${reason}\n\n${confirmIT}`;
}

/** Screen every public field, including file contents before the upload stage. */
export function guardHelpGeneratedAnswer(answer: Generated, messages: Messages, hasAttachments = false): Generated {
  const text = [answer.text, ...(answer.suggestions || []), ...(answer.questions || []).flatMap(question => [question.question, question.header,
    ...question.options.flatMap(option => [option.label, option.description || ''])]), ...(answer.files || []).flatMap(file => [file.name, file.content])];
  const inspections = text.map(value => inspectHelpAnswer(value, { phase: 'final', messages, hasAttachments }));
  const unsafe = inspections.find(value => !value.safe && value.code !== 'HELP_ANSWER_UNGROUNDED_DIAGNOSTICS') || inspections.find(value => !value.safe);
  if (!unsafe) return answer;
  if (unsafe.code === 'HELP_ANSWER_UNGROUNDED_DIAGNOSTICS') return { ...answer, decision: 'clarify', text: 'Здравствуйте! С чем нужна помощь?', sources: [], files: [], suggestions: [],
    questions: [{ id: 'help-request', header: 'Задача', question: 'С чем нужна помощь?', options: [], multiSelect: false }] };
  return { ...answer, decision: 'handoff', text: 'Для таких изменений нужна проверка IT-специалистом. Можно продолжить диагностику без изменения защиты, прав доступа и конфигурации базы.', sources: [], files: [], questions: [], suggestions: [] };
}

/** The lease/source/proof fences remain owned by the original progress writer. */
export function guardHelpAIProgress<T extends PublicProgress>(progress: ((update: T) => Promise<void>) | undefined, messages: Messages, hasAttachments = false): ((update: T) => Promise<void>) | undefined {
  if (!progress) return undefined;
  return async update => {
    let checked = update;
    if (typeof update.draftText === 'string' && !inspectHelpAnswer(update.draftText, { phase: 'draft', messages, hasAttachments }).safe) checked = { ...checked, draftText: '', flush: true };
    if (update.activity?.kind === 'analysis' && update.activity.text && !inspectHelpAnswer(update.activity.text, { phase: 'draft', messages, hasAttachments }).safe) {
      checked = { ...checked, activity: { ...update.activity, text: 'Проверяю безопасный порядок диагностики.' }, flush: true };
    }
    return progress(checked);
  };
}
