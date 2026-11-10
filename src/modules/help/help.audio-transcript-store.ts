import { randomUUID } from 'node:crypto';
import prisma from '../../prisma/client';
import type { HelpAudioTranscript } from './help.ai-audio';

type Row = { sourceKey: string; status: string; text: string | null; truncated: boolean; lockedUntil: Date | null };
export interface HelpAudioTranscriptStore {
  read(id: string, sourceKey: string): Promise<HelpAudioTranscript>;
  claim(id: string, sourceKey: string, model: string): Promise<string | null>;
  finish(id: string, sourceKey: string, token: string, result: HelpAudioTranscript): Promise<void>;
  release(id: string, sourceKey: string, token: string): Promise<void>;
}
/** A durable result belongs to the immutable attachment, not to one API process or model version. */
export const helpAudioTranscriptStore: HelpAudioTranscriptStore = {
  async read(id, sourceKey) {
    const rows = await prisma.$queryRaw<Row[]>`SELECT "sourceKey",status,text,truncated,"lockedUntil" FROM "HelpAudioTranscript" WHERE "attachmentId"=${id}`;
    const row = rows[0];
    if (!row || row.sourceKey !== sourceKey) return { attachmentId: id, status: 'not_started' };
    if (row.status === 'TRANSCRIBED' || row.status === 'NO_SPEECH') return { attachmentId: id, status: row.status === 'TRANSCRIBED' ? 'transcribed' : 'no_speech', text: row.text || '', truncated: row.truncated };
    if (row.status === 'PROCESSING' && row.lockedUntil && row.lockedUntil.getTime() > Date.now()) return { attachmentId: id, status: 'pending' };
    return { attachmentId: id, status: 'unavailable', reason: 'transcription_unavailable' };
  },
  async claim(id, sourceKey, model) {
    const token = randomUUID();
    const rows = await prisma.$queryRaw<{ leaseToken: string }[]>`
      INSERT INTO "HelpAudioTranscript" ("attachmentId","sourceKey",model,status,"leaseToken","lockedUntil","updatedAt")
      VALUES (${id},${sourceKey},${model},'PROCESSING',${token},now()+interval '180 seconds',now())
      ON CONFLICT ("attachmentId") DO UPDATE SET "sourceKey"=EXCLUDED."sourceKey",model=EXCLUDED.model,status='PROCESSING',text=NULL,truncated=false,
        "leaseToken"=EXCLUDED."leaseToken","lockedUntil"=EXCLUDED."lockedUntil","updatedAt"=now()
      WHERE ("HelpAudioTranscript".status NOT IN ('TRANSCRIBED','NO_SPEECH') OR "HelpAudioTranscript"."sourceKey"<>EXCLUDED."sourceKey")
        AND ("HelpAudioTranscript"."lockedUntil" IS NULL OR "HelpAudioTranscript"."lockedUntil"<now())
      RETURNING "leaseToken"`;
    return rows[0]?.leaseToken === token ? token : null;
  },
  async finish(id, sourceKey, token, result) {
    const status = result.status === 'transcribed' ? 'TRANSCRIBED' : result.status === 'no_speech' ? 'NO_SPEECH' : 'FAILED';
    await prisma.$executeRaw`UPDATE "HelpAudioTranscript" SET status=${status},text=${result.text ?? null},truncated=${!!result.truncated},"leaseToken"=NULL,"lockedUntil"=NULL,"updatedAt"=now()
      WHERE "attachmentId"=${id} AND "sourceKey"=${sourceKey} AND "leaseToken"=${token}`;
  },
  async release(id, sourceKey, token) {
    await prisma.$executeRaw`UPDATE "HelpAudioTranscript" SET status='FAILED',"leaseToken"=NULL,"lockedUntil"=NULL,"updatedAt"=now()
      WHERE "attachmentId"=${id} AND "sourceKey"=${sourceKey} AND "leaseToken"=${token}`;
  },
};
