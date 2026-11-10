import prisma from '../../prisma/client';
import { helpAIAudio } from './help.ai-audio';
import { HelpError, helpActor, requireHelpTicket, type HelpActor } from './help.service';

/** Both AI and UI use the same durable attachment result. Every disclosure reauthorizes. */
export async function helpAttachmentTranscript(id: string, actor: HelpActor, request: boolean, clientSignal: AbortSignal) {
  clientSignal.throwIfAborted();
  // Once explicitly requested, finish recognition even if its view closes. A new
  // view then joins the same durable result instead of paying for another call.
  const signal = request ? AbortSignal.timeout(110000) : clientSignal;
  const file = await prisma.helpAttachment.findUnique({ where: { id }, include: { message: true } });
  if (!file?.message || file.kind !== 'AUDIO' || file.message.kind !== 'TEXT' || file.message.authorId !== file.ownerId) {
    throw new HelpError(404, 'HELP_NOT_FOUND', 'Голосовое сообщение не найдено');
  }
  const ticket = await requireHelpTicket(prisma, file.message.ticketId, actor);
  const validate = async () => {
    signal.throwIfAborted();
    const currentActor = await helpActor(actor.userId);
    const current = await requireHelpTicket(prisma, ticket.id, currentActor);
    if (current.ownerId !== ticket.ownerId) throw new HelpError(409, 'HELP_CONTEXT_CHANGED', 'Обращение изменено');
  };
  const reader = helpAIAudio(ticket.id, ticket.ownerId, file.message.sequence, validate, fetch, undefined, file.ownerId);
  return request ? reader.transcribe(id, signal) : reader.read(id, signal);
}
