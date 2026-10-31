import { HelpGroundedAnswer, knowledgeHandoff, renderKnowledgeExcerpts, retrieveHelpKnowledge, validateHelpKnowledgeSources } from './help.knowledge';
import { HelpOpenAIError, OpenAIContext, requestOpenAIAnswer } from './help.openai';
import prisma from '../../prisma/client';
import { helpOnecTools, HelpOnecConnectionRequired, onecConnectAnswer } from './help.onec-tools';

export async function prepareHelpOpenAIAnswer(ticketId: number, ownerId: number, context: unknown, signal: AbortSignal): Promise<HelpGroundedAnswer> {
  const result = await retrieveHelpKnowledge(ticketId, ownerId, context);
  const onec = helpOnecTools(ownerId);
  if ('answer' in result && (!onec || result.answer.handoffReason === 'user_requested')) return result.answer;
  const hits = 'answer' in result ? [] : result.hits;
  const sources = renderKnowledgeExcerpts(hits).sources.map(source => ({ ...source,
    excerpt: hits.filter(hit => hit.documentId === source.documentId).map(hit => hit.excerpt).join('\n\n') }));
  // Recheck eligibility immediately before external disclosure as well as before saving the answer.
  await prisma.$transaction(tx => validateHelpKnowledgeSources(tx, sources, ownerId));
  const messages: OpenAIContext['messages'] = 'answer' in result ? (Array.isArray(context) ? context.filter(x => typeof x?.text === 'string').map(x => ({ role: 'user' as const, text: x.text })) : []) : result.messages;
  const input: OpenAIContext = { messages, sources, onec };
  try {
    const generated = await requestOpenAIAnswer(input, signal);
    await onec?.validate();
    const generation = { model: generated.model, responseId: generated.responseId, decision: generated.decision, usage: generated.usage };
    if (generated.decision === 'handoff') return { ...knowledgeHandoff('model_handoff'), mode: 'openai', generation, validationSources: sources };
    const references = generated.sources.map((source, index) => `[${index + 1}] ${source.title} · версия ${source.revision}\nПапка: ${source.path}`).join('\n');
    return { mode: 'openai', generation, validationSources: sources, onecProofs: onec?.proofs, sources: generated.sources.map(({ excerpt, ...source }) => source),
      text: generated.text + (references ? '\n\nИсточники:\n' + references : '') };
  } catch (error) {
    if (error instanceof HelpOnecConnectionRequired) return onecConnectAnswer(error.baseKey);
    if (error instanceof HelpOpenAIError && error.code === 'HELP_OPENAI_REFUSAL') return { ...knowledgeHandoff('model_handoff'), mode: 'openai', validationSources: sources };
    throw error;
  }
}
