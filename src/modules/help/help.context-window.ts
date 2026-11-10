import type { HelpContextMessage, HelpContextSummary } from './help.context-store';
import type { HelpAIProgress } from './help.ai-stream';

export const HELP_CONTEXT_WINDOW_BYTES = 96 * 1024;
export const HELP_CONTEXT_COMPACT_BYTES = 64 * 1024;
const KEEP_RECENT_BYTES = 24 * 1024;
const COMPACT_INPUT_BYTES = 128 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export type HelpConversationSnapshot = {
  messages: HelpContextMessage[]; summary?: HelpContextSummary; summaryCoveredMessages?:number; totalMessages: number; omittedBefore: number;
};
export type HelpConversationWindow = {
  messages: HelpContextMessage[]; summary?: HelpContextSummary;
  coverage: { totalMessages: number; quotedMessages: number; summaryThrough: number; omittedMessages: number; omittedBeforeSummary?:number; throughSequence: number; compaction: 'not_needed'|'ready'|'unavailable' };
};
/** Whole messages with explicit coverage, never a silent per-message substring. */
function tail(messages: HelpContextMessage[], budget: number) {
  const selected: HelpContextMessage[] = []; let size = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index], cost = bytes(message);
    if (selected.length && size + cost > budget) break;
    selected.push(message); size += cost;
  }
  return selected.reverse();
}

export async function prepareHelpConversationWindow(options: {
  snapshot: HelpConversationSnapshot; model: string; signal: AbortSignal; progress?: HelpAIProgress;
  fingerprint: (throughSequence: number) => Promise<string>;
  compact: (previous: HelpContextSummary | undefined, messages: HelpContextMessage[]) => Promise<HelpContextSummary['items']>;
}): Promise<HelpConversationWindow> {
  const {snapshot,signal} = options; signal.throwIfAborted();
  let summary = snapshot.summary, compaction: HelpConversationWindow['coverage']['compaction'] = 'not_needed';
  let pending = snapshot.messages.filter(m => m.sequence > (summary?.coveredThrough || 0));
  const missingBeforePending=summary && typeof snapshot.summaryCoveredMessages==='number'
    ? Math.max(0,snapshot.totalMessages-snapshot.summaryCoveredMessages-pending.length):snapshot.omittedBefore;
  if (bytes(pending) + bytes(summary?.items || []) > HELP_CONTEXT_COMPACT_BYTES && pending.length > 1) {
    const recent = tail(pending, KEEP_RECENT_BYTES);
    const prefix = pending.filter(m => m.sequence < recent[0].sequence);
    let candidates = tail(prefix, COMPACT_INPUT_BYTES);
    // Keep the original employee goal as evidence when importing a legacy long chat.
    const first = !summary ? prefix.find(m => m.role === 'user') : undefined;
    if (first && !candidates.some(m=>m.id===first.id)) candidates=[first,...tail(prefix.filter(m=>m.id!==first.id),Math.max(1,COMPACT_INPUT_BYTES-bytes(first)))];
    if (candidates.length) {
      await options.progress?.({activity:{id:'context',kind:'status',label:'Обновляю рабочий контекст обращения',status:'running'},phase:'context',flush:true});
      const through = candidates[candidates.length-1].sequence;
      const fingerprint = await options.fingerprint(through); signal.throwIfAborted();
      try {
        const items = await options.compact(summary,candidates); signal.throwIfAborted();
        if (!items.length || items.length>64 || new Set(items.flatMap(item=>item.messageIds)).size>512 || JSON.stringify(items).length>60000) throw new Error('HELP_CONTEXT_INVALID_SUMMARY');
        const current = await options.fingerprint(through); signal.throwIfAborted();
        if (current !== fingerprint) {
          const error = new Error('HELP_CONTEXT_CHANGED') as Error & {code:string}; error.code='HELP_CONTEXT_CHANGED'; throw error;
        }
        summary = {version:1,model:options.model,coveredThrough:through,fingerprint,items,
          omittedBefore:(summary?.omittedBefore||0)+missingBeforePending+prefix.length-candidates.length};
        pending = recent; compaction='ready';
        await options.progress?.({activity:{id:'context',kind:'status',label:'Рабочая сводка подготовлена; оригиналы доступны в истории',status:'completed'},flush:true});
      } catch (error) {
        signal.throwIfAborted();
        if ((error as {code?:string}).code === 'HELP_CONTEXT_CHANGED' || [403,404].includes((error as {status?:number}).status||0)) throw error;
        // Compaction is an optimization: exact authorized history remains available
        // through retrieval even if a provider cannot prepare the summary now.
        compaction='unavailable';
        await options.progress?.({activity:{id:'context',kind:'status',label:'История доступна для поиска и перечитывания',status:'completed'},flush:true});
      }
    }
  }
  let messages = tail(pending, HELP_CONTEXT_WINDOW_BYTES);
  signal.throwIfAborted();
  const first = snapshot.messages[0];
  // For unsummarized imports, preserve the initial goal if it fits as a whole.
  if (!summary && first && !messages.some(m=>m.id===first.id)) messages=[first,...tail(pending.filter(m=>m.id!==first.id),Math.max(1,HELP_CONTEXT_WINDOW_BYTES-bytes(first)))];
  return {messages,...(summary?{summary}:{}),coverage:{
    totalMessages:snapshot.totalMessages,quotedMessages:messages.length,summaryThrough:summary?.coveredThrough||0,
    omittedMessages:Math.max(0,snapshot.totalMessages-messages.length),
    omittedBeforeSummary:summary?(summary.omittedBefore||0):missingBeforePending,
    throughSequence:snapshot.messages[snapshot.messages.length-1]?.sequence||0,compaction,
  }};
}
