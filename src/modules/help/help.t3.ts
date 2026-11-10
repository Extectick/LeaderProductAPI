import prisma from '../../prisma/client';
import { knowledgeEnabled } from '../knowledge/knowledge.config';
import { type HelpGroundedAnswer, type HelpKnowledgeSource, knowledgeHandoff, renderKnowledgeExcerpts, retrieveHelpKnowledge, validateHelpKnowledgeSources } from './help.knowledge';
import { requestT3Answer, type T3Context, type T3Job } from './help.t3-exchange';

/** Keep recent text within the existing ticket. No attachments, signed URLs, credentials or global history. */
export function buildT3Context(messages: T3Context['messages'], sources: Array<HelpKnowledgeSource & { excerpt: string }> = []): T3Context {
  let budget = 6000;
  const selected: T3Context['messages'] = [];
  for (const item of [...messages].reverse()) {
    const text = item.text.trim().slice(-Math.min(3000, budget));
    if (text && budget > 0) { selected.unshift({ role: item.role, text }); budget -= text.length; }
    if (budget <= 0 || selected.length >= 16) break;
  }
  let remaining = 9500;
  return { messages: selected, sources: sources.slice(0, 3).map((source, index) => {
    const excerpt = source.excerpt.slice(0, remaining); remaining -= excerpt.length;
    return { id: `S${index + 1}`, title: source.title.slice(0, 200), revision: source.revision, excerpt };
  }).filter(source => source.excerpt.trim()) };
}

export async function prepareHelpT3Answer(job: T3Job, context: unknown, signal: AbortSignal): Promise<HelpGroundedAnswer> {
  let messages: T3Context['messages'] = [];
  let sources: Array<HelpKnowledgeSource & { excerpt: string }> = [];
  if (knowledgeEnabled()) {
    const retrieved = await retrieveHelpKnowledge(job.ticketId, job.ownerId, context);
    if ('answer' in retrieved) {
      // An explicit dev opt-in allows general support when no matching company
      // instruction exists. Outages and requested IT handoffs keep their existing behavior.
      if (retrieved.answer.handoffReason !== 'no_knowledge' || process.env.HELP_T3_ALLOW_GENERAL !== 'true') return retrieved.answer;
    } else {
      messages = retrieved.messages;
      sources = renderKnowledgeExcerpts(retrieved.hits).sources.map(source => ({ ...source,
        excerpt: retrieved.hits.filter(hit => hit.documentId === source.documentId).map(hit => hit.excerpt).join('\n\n') }));
      await prisma.$transaction(tx => validateHelpKnowledgeSources(tx, sources, job.ownerId));
    }
  }
  if (!messages.length) {
    const recent = await prisma.helpMessage.findMany({ where: { ticketId: job.ticketId, kind: 'TEXT',
      OR: [{ authorId: job.ownerId }, { authorId: null, authorRole: 'SYSTEM' }] },
      orderBy: { sequence: 'desc' }, take: 16, select: { authorId: true, text: true } });
    messages = recent.reverse().map(message => ({ role: message.authorId === job.ownerId ? 'user' : 'assistant', text: message.text }));
    if (!messages.some(message => message.role === 'user')) messages.push(...(Array.isArray(context) ? context : [])
      .filter(item => typeof item?.text === 'string').map(item => ({ role: 'user' as const, text: item.text })));
  }
  const generated = await requestT3Answer(job, buildT3Context(messages, sources), sources, signal);
  const generation = { model: 't3-configured-provider', responseId: generated.responseId, decision: generated.decision, usage: null };
  if (generated.decision === 'handoff') return { ...knowledgeHandoff('model_handoff'), mode: 't3', generation, validationSources: sources };
  const used = generated.source_ids.map(id => sources[Number(id.slice(1)) - 1]);
  const references = used.map((source, index) => `[${index + 1}] ${source.title} · версия ${source.revision}\nПапка: ${source.path}`).join('\n');
  return { mode: 't3', generation, validationSources: sources, sources: used.map(({ excerpt, ...source }) => source),
    text: generated.message + (references ? '\n\nИсточники:\n' + references : '') };
}
