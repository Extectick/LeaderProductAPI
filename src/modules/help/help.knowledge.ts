import { Prisma } from '@prisma/client';
import prisma from '../../prisma/client';
import { KnowledgeError, knowledgeConfig, knowledgeEnabled, SOURCE_FRESH_MS } from '../knowledge/knowledge.config';
import { knowledgeActor, knowledgeSourceWhere, searchKnowledge, KnowledgeActor } from '../knowledge/knowledge.service';

export type HelpKnowledgeSource = { documentId: string; versionId: string; revision: number; title: string; path: string; sourceUrl: string };
export type HelpGroundedAnswer = { text: string; sources: HelpKnowledgeSource[]; mode: 'knowledge-excerpts' | 'openai' | 'bunny' | 't3';
  validateAppAccess?: (db:Prisma.TransactionClient)=>Promise<void>;
  contextSummary?: import('./help.context-store').HelpContextSummary;
  contextRevision?: {throughSequence:number;fingerprint:string};
  suggestions?: string[];
  questions?: import('./help.questions').HelpAIQuestion[];
  files?: import('./help.ai-file-contract').HelpAIFile[];
  officeFiles?: import('./help.office-contract').HelpOfficeFile[];
  htmlFiles?: import('./help.html').HelpHtmlFile[];
  action?: { type: 'connect_onec'; baseKey?: string } | { type: 'request_it' };
  onecProofs?: import('../onec-personal/service').OnecProof[];
  handoffReason?: 'no_knowledge' | 'source_unavailable' | 'user_requested' | 'model_handoff';
  generation?: { model: string; responseId: string; decision: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number; reasoningTokens?: number } | null };
  validationSources?: HelpKnowledgeSource[];
};
export type HelpKnowledgeHit = Awaited<ReturnType<typeof searchKnowledge>>[number];
type Hit = HelpKnowledgeHit;
const STOP = new Set('и в во на из к с со по о об у для до не нет как что это мне меня мой моя мы наш у нас вас вы я он она они оно ли или а но да где когда почему пожалуйста помогите подскажите здравствуйте добрый день проблема работает работать нужно надо могу может сделать сейчас после уже ещё еще так только все всё же then the is are my please help this'.split(' '));

/** Natural questions must not become a huge AND query; operators come from code, not documents. */
export function helpKnowledgeQuery(context: unknown) {
  const values = Array.isArray(context) ? context.filter(item => item && typeof item.text === 'string').map(item => String(item.text).slice(0, 4000)) : [];
  const ordered = values.length > 1 ? [values[values.length - 1], values[0], ...values.slice(1, -1).reverse()] : values;
  const words = [...new Set(ordered.join(' ').toLowerCase().normalize('NFC').replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || [])]
    .filter(word => word.length >= 2 && word.length <= 40 && !STOP.has(word) && word !== 'or').slice(0, 18);
  const terms: string[] = [];
  for (const word of words) { if ([...terms, word].join(' OR ').length > 300) break; terms.push(word); }
  return terms.join(' OR ');
}

const QUERY_NOISE = new Set('чтобы есть получаю выдает выдаёт появляется сообщает снова хочу перестал перестала кто какой какая какое куда при код ошибка ошибки возникает показывает уточнение модель'.split(' '));
const isCode = (word: string) => /^(?=.*\d)[\p{L}\p{N}]{3,40}$/u.test(word);
/** Lexical relevance guard, not a semantic confidence score. A new explicit code replaces old codes. */
export function helpSearchTerms(context: unknown) {
  const values = Array.isArray(context) ? context.filter(item => typeof item?.text === 'string') : [];
  const latest = values.length ? helpKnowledgeQuery([values[values.length - 1]]).split(' OR ').filter(Boolean) : [];
  const requiredTerms = latest.filter(isCode);
  const terms = helpKnowledgeQuery(context).split(' OR ').filter(word => word && !QUERY_NOISE.has(word) &&
    (!isCode(word) || !requiredTerms.length || requiredTerms.includes(word)));
  return { terms, requiredTerms, minCoverage: 0.6 };
}
export async function searchHelpKnowledge(context: unknown, actor: KnowledgeActor) {
  const relevance = helpSearchTerms(context);
  if (!relevance.terms.length) return [];
  return selectHelpKnowledge(await searchKnowledge(relevance.terms.join(' OR '), actor, 20, true, relevance));
}

export function selectHelpKnowledge(hits: Hit[]) {
  const selected: Hit[] = [], perDocument = new Map<string, number>(); let chars = 0;
  for (const hit of hits) {
    if (perDocument.size >= 3 && !perDocument.has(hit.documentId) || (perDocument.get(hit.documentId) || 0) >= 2) continue;
    if (!hit.excerpt.trim() || chars + hit.excerpt.length > 9500) continue;
    if (selected.some(previous => previous.chunkId === hit.chunkId || previous.excerpt === hit.excerpt)) continue;
    selected.push(hit); chars += hit.excerpt.length; perDocument.set(hit.documentId, (perDocument.get(hit.documentId) || 0) + 1);
  }
  return selected;
}

export function renderKnowledgeExcerpts(hits: Hit[]): HelpGroundedAnswer {
  const sources: HelpKnowledgeSource[] = [];
  for (const hit of hits) if (!sources.some(source => source.documentId === hit.documentId)) {
    const { documentId, versionId, revision, title, path, sourceUrl } = hit;
    sources.push({ documentId, versionId, revision, title, path, sourceUrl });
  }
  const sections = sources.map((source, index) => {
    const excerpts = hits.filter(hit => hit.documentId === source.documentId).map(hit => hit.excerpt).join('\n\n…\n\n');
    return `[${index + 1}] ${source.title} · версия ${source.revision}\n${excerpts}\n\nПапка: ${source.path}`;
  });
  return { mode: 'knowledge-excerpts', sources,
    text: 'Нашёл материалы компании по вашему вопросу. Ниже выдержки из документов; проверьте, относятся ли они к вашей ситуации.\n\n' + sections.join('\n\n────────\n\n') + '\n\nЕсли инструкция не подходит или не помогла, напишите об этом — я предложу подключить IT-специалиста.' };
}

export function knowledgeHandoff(reason: NonNullable<HelpGroundedAnswer['handoffReason']>): HelpGroundedAnswer {
  const text = reason === 'source_unavailable' ? 'Сейчас не удалось проверить актуальные инструкции компании.' : reason === 'user_requested' ? 'Могу предложить помощь IT-специалиста.' : reason === 'model_handoff' ? 'Не удалось найти надёжное решение вашего вопроса.' : 'В доступных материалах компании не нашлось инструкции по этому вопросу.';
  return { mode: 'knowledge-excerpts', sources: [], handoffReason: reason, action: { type: 'request_it' },
    text: text + ' Чтобы подключить IT-специалиста, нажмите кнопку под сообщением и подтвердите передачу. Переписка и уже выполненные проверки останутся в этом обращении.' };
}

export type HelpKnowledgeRetrieval = { answer: HelpGroundedAnswer } | {
  hits: Hit[]; messages: Array<{ role: 'user' | 'assistant'; text: string }>;
};
/** Explicit requests offer IT confirmation without a model call; questions and negations do not. */
export function requestsHelpIT(text: string): boolean {
  const value = text.toLowerCase().replace(/ё/g, 'е');
  if (/(?:^|[^а-яa-z])(?:не\s+(?:надо|нужно|хочу|нужен|нужна|подключ|переда|зови)|без\s+(?:it|ит|специалиста))|(?:как|когда|зачем)\s+(?:мне\s+)?(?:подключ|позва|вызва|переда)/u.test(value)) return false;
  // Generic specialists may be medical, emergency, warehouse or other staff.
  // Only an explicit IT destination bypasses model interpretation.
  const target = /(?:^|[^a-zа-я])(?:it|ит)(?:$|[^a-zа-я])|техподдержк|техническ(?:ая|ую|ой)\s+поддержк/u.test(value);
  const request = /(?:^|[^а-я])(?:подключи(?:те)?|позови(?:те)?|вызови(?:те)?|передай(?:те)?|переда(?:ть|йте)|нужен|нужна|нужно|хочу)(?:$|[^а-я])/u.test(value);
  return target && request;
}
export async function retrieveHelpKnowledge(ticketId: number, ownerId: number, context: unknown): Promise<HelpKnowledgeRetrieval> {
  if (!knowledgeEnabled()) return { answer: knowledgeHandoff('source_unavailable') };
  let actor;
  try { actor = await knowledgeActor(ownerId); } catch (error) {
    if (error instanceof KnowledgeError && error.status === 403) return { answer: knowledgeHandoff('no_knowledge') };
    throw error;
  }
  const recent = await prisma.helpMessage.findMany({ where: { ticketId, kind: 'TEXT' }, orderBy: { sequence: 'desc' }, take: 16,
    select: { text: true, authorId: true, sequence: true } });
  const latestOwner = recent.find(message => message.authorId === ownerId);
  if (requestsHelpIT(latestOwner?.text || '')) return { answer: knowledgeHandoff('user_requested') };
  if (!await prisma.knowledgeSource.findFirst({ where: knowledgeSourceWhere(), select: { id: true } })) return { answer: knowledgeHandoff('source_unavailable') };
  const first = await prisma.helpMessage.findFirst({ where: { ticketId, authorId: ownerId, kind: 'TEXT' }, orderBy: { sequence: 'asc' }, select: { text: true, sequence: true } });
  const inputs = [first, ...recent.filter(message => message.authorId === ownerId).reverse(), ...(Array.isArray(context) ? context : [])].filter(Boolean);
  // Help is visible to IT managers. Restricted documents must not be copied into a more widely visible ticket.
  const hits = await searchHelpKnowledge(inputs, actor);
  if (!hits.length) return { answer: knowledgeHandoff('no_knowledge') };
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  if (first && !recent.some(message => message.sequence === first.sequence)) messages.push({ role: 'user', text: first.text });
  for (const message of [...recent].reverse()) if (message.authorId === ownerId || message.authorId === null) {
    messages.push({ role: message.authorId === ownerId ? 'user' : 'assistant', text: message.text });
  }
  // Isolated evaluations can supply context without creating a real ticket.
  if (!messages.length && Array.isArray(context)) for (const item of context) if (typeof item?.text === 'string') messages.push({ role: 'user', text: item.text });
  return { hits, messages };
}

export async function prepareHelpKnowledgeAnswer(ticketId: number, ownerId: number, context: unknown): Promise<HelpGroundedAnswer> {
  const result = await retrieveHelpKnowledge(ticketId, ownerId, context);
  return 'answer' in result ? result.answer : renderKnowledgeExcerpts(result.hits);
}

/** Serialize against publication/scan changes before saving the answer, not just before retrieval. */
export async function validateHelpKnowledgeSources(tx: Prisma.TransactionClient, sources: HelpKnowledgeSource[], ownerId: number) {
  if (!sources.length) return;
  await knowledgeActor(ownerId);
  const config = knowledgeConfig();
  await tx.$queryRaw`SELECT "id" FROM "KnowledgeSource" WHERE "key"=${config.key} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "KnowledgeDocument" WHERE "id" IN (${Prisma.join(sources.map(source => source.documentId))}) ORDER BY "id" FOR SHARE`;
  const rows = await tx.knowledgeDocument.findMany({ where: { id: { in: sources.map(source => source.documentId) }, allEmployees: true, section: 'COMPANY', deletedAt: null,
    source: { key: config.key, configFingerprint: config.fingerprint, enabled: true, lastErrorCode: null, lastSuccessAt: { gt: new Date(Date.now() - SOURCE_FRESH_MS) } } },
    select: { id: true, currentRevision: true, publishedRevision: true, versions: { select: { id: true, revision: true, status: true }, where: { id: { in: sources.map(source => source.versionId) } } } } });
  if (sources.some(source => !rows.some(row => row.id === source.documentId && row.publishedRevision === source.revision && row.currentRevision === source.revision && row.versions.some(version => version.id === source.versionId && version.status === 'READY')))) {
    throw new KnowledgeError(409, 'HELP_KNOWLEDGE_CHANGED', 'Источники изменились во время подготовки ответа');
  }
}
