import { helpPerformanceSnapshot, markHelpFirstDraft, markHelpFirstDraftPersisted } from './help.performance';
import type { Prisma } from '@prisma/client';
import { helpTransaction, publishHelpEvent } from './help.service';
import type { HelpAIActivity, HelpAIProgress } from './help.ai-stream';
import {validateHelpKnowledgeSources,type HelpKnowledgeSource} from './help.knowledge';
import {validateOnecProofs,type OnecProof} from '../onec-personal/service';

export function helpAIErrorMessage(code: string, retrying = false) {
  if(code==='HELP_OPENAI_ACTION_RESULT_UNAVAILABLE')return 'Не удалось завершить пояснение после запроса изменения. Действие могло выполниться; автоматический повтор остановлен. Проверьте текущее состояние объекта чтением.';
  if(code==='HELP_APP_STATS_FORBIDDEN')return 'Право просмотра статистики пользователей недоступно или изменилось. Данные не опубликованы. Можно обратиться к администратору.';
  if(code==='HELP_APP_STATS_UNVERIFIED')return 'Не удалось проверить текущую статистику пользователей. Непроверенные числа не сохранены. Повторите запрос или подключите IT.';
  if (code === 'HELP_CONTEXT_CHANGED') return retrying ? 'История обращения изменилась. Обновляю контекст…' : 'История обращения изменилась во время проверки. Непроверенный ответ не сохранён.';
  if (['HELP_AI_INVALID_FILE', 'HELP_AI_FILE_MISSING', 'HELP_AI_FILE_UPLOAD'].includes(code)) return retrying
    ? 'Не удалось подготовить вложение. Повторяем запрос…'
    : 'Не удалось создать и прикрепить файл. Повторите запрос или вызовите IT-специалиста.';
  if (code === 'HELP_OPENAI_QUOTA') return 'ИИ временно недоступен: закончился лимит сервиса. Можно подключить IT.';
  if (['HELP_OPENAI_HTTP_400', 'HELP_OPENAI_HTTP_401', 'HELP_OPENAI_HTTP_403', 'HELP_OPENAI_NOT_CONFIGURED'].includes(code)) return 'Сервис ИИ требует проверки подключения администратором. Можно подключить IT.';
  if (['HELP_OPENAI_INVALID_RESPONSE', 'HELP_OPENAI_INCOMPLETE', 'HELP_OPENAI_RESPONSE_TOO_LARGE'].includes(code)) return retrying
    ? 'ИИ вернул неполный ответ. Повторяем запрос…'
    : 'Не удалось получить корректный ответ ИИ после повторных попыток. Повторите запрос или подключите IT.';
  if (code === 'HELP_OPENAI_INVALID_CITATIONS') return 'Не удалось подтвердить источники ответа ИИ. Ответ не сохранён. Повторите запрос или подключите IT.';
  if (code === 'HELP_OPENAI_UNGROUNDED_DATA') return 'Не удалось подтвердить данные 1С в рамках этой проверки. Непроверенный ответ не сохранён.';
  if (['HELP_OPENAI_INVALID_TOOL', 'HELP_OPENAI_TOOL_LIMIT'].includes(code)) return 'ИИ не смог завершить разрешённую проверку. Повторите запрос или подключите IT.';
  if (code === 'HELP_OPENAI_HTTP_429') return retrying ? 'Сервис ИИ занят. Повторим запрос автоматически…' : 'Сервис ИИ пока занят. Повторите запрос позже или подключите IT.';
  if (retrying) return 'Связь с ИИ прервалась. Повторяем запрос…';
  if (code === 'HELP_OPENAI_TIMEOUT') return 'ИИ не успел ответить. Повторите запрос или подключите IT.';
  if (code === 'HELP_OPENAI_NETWORK' || /^HELP_OPENAI_HTTP_5\d\d$/.test(code)) return 'Сервис ИИ временно недоступен. Повторите запрос или подключите IT.';
  return 'Не удалось завершить ответ. Повторите запрос или подключите IT.';
}

export function createHelpAIProgress(job: { id: string; ticketId: number; messageId: number; leaseToken: string }, signal: AbortSignal): HelpAIProgress {
  const activities = new Map<string, HelpAIActivity>();
  const startedAt = Date.now(); let lastWrite = 0, draftText = '', phase = 'knowledge';
  let sources:HelpKnowledgeSource[]=[];
  let proofs:OnecProof[]=[];
  let validateAppAccess:((db:Prisma.TransactionClient)=>Promise<void>)|undefined;
  let firstAnalysisMs: number | undefined, firstTokenMs: number | undefined;
  return async update => {
    if (signal.aborted) throw new Error('HELP_AI_CANCELLED');
    if(update.validationSources)sources=update.validationSources;
    if(update.validationProofs)proofs=update.validationProofs;
    if(update.validateAppAccess)validateAppAccess=update.validateAppAccess;
    if (update.activity) {
      const activity = update.activity, previous = activities.get(activity.id);
      if (activities.size >= 24 && !previous) return;
      activities.set(activity.id, { ...previous, ...activity, label: activity.label.slice(0, 180),
        text: activity.text?.slice(0, 4000) ?? previous?.text, startedAt: previous?.startedAt ?? Date.now(),
        ...(activity.status !== 'running' ? { completedAt: Date.now() } : {}) });
      if (activity.kind === 'analysis' && activity.text?.trim()) firstAnalysisMs ??= Date.now() - startedAt;
    }
    if (update.draftText !== undefined) { draftText = update.draftText.slice(0, 12000); if (draftText) { firstTokenMs ??= Date.now() - startedAt; markHelpFirstDraft(); } }
    if (update.phase) phase = update.phase;
    const now = Date.now();
    if (!update.flush && now - lastWrite < 200 && (!update.activity || update.activity.status === 'running')) return;
    lastWrite = now;
    let remaining = 12000;
    const bounded = [...activities.values()].reverse().map(item => {
      const text = item.text?.slice(0, Math.max(0, remaining)); remaining -= text?.length || 0;
      return { ...item, ...(text === undefined ? {} : { text }) };
    }).reverse();
    await helpTransaction(job.ticketId, async db => {
      const owned = await db.helpAssistantJob.findFirst({ where: { id: job.id, leaseToken: job.leaseToken, provider: 'openai',
        status: 'RUNNING', leaseUntil: { gt: new Date() }, ticket: { status: 'OPEN', itRequested: false, members: { none: { role: 'IT' } } } } });
      if (!owned || signal.aborted || process.env.HELP_AI_PROVIDER !== 'openai') throw new Error('HELP_AI_CANCELLED');
      if(sources.length)await validateHelpKnowledgeSources(db,sources,owned.ownerId);
      await validateAppAccess?.(db);
      if(proofs.length){await db.$executeRaw`SELECT pg_advisory_xact_lock(190154, ${owned.ownerId}::int)`;await validateOnecProofs(owned.ownerId,proofs,db);}
      const current = await db.helpMessage.findUniqueOrThrow({ where: { id: job.messageId }, select: { assistantState: true } });
      const previous = current.assistantState && typeof current.assistantState === 'object' && !Array.isArray(current.assistantState) ? current.assistantState : {};
      const event = await publishHelpEvent(db, job.ticketId, null, 'ASSISTANT_UPDATED', job.messageId);
      await db.helpMessage.update({ where: { id: job.messageId }, data: { assistantState: {
        ...previous, activityVersion: 1, activities: bounded, phase, draftText, error: null, retryAt: null,
        status: draftText ? 'streaming' : 'thinking', eventId: event.id, updatedAt: now,
        metrics: { ...(helpPerformanceSnapshot(job.id) ? {performance:helpPerformanceSnapshot(job.id)} : {}), startedAt, elapsedMs: now - startedAt, ...(firstAnalysisMs !== undefined ? { firstAnalysisMs } : {}), ...(firstTokenMs !== undefined ? { firstTokenMs } : {}) },
      } as unknown as Prisma.InputJsonObject } });
    });
    if (draftText) markHelpFirstDraftPersisted();
  };
}
