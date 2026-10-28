export const HELP_EDIT_MS = 60 * 60 * 1000;
export const HELP_REOPEN_MS = 72 * 60 * 60 * 1000;
export const HELP_MAX_ATTACHMENTS = 10;
export const HELP_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const HELP_REACTIONS = ['❤️', '👍', '👎', '🔥', '🥰', '👏', '😀', '😢', '🎉', '🙏'];
export function canEditHelpMessage(authorId: number, userId: number, createdAt: Date, now = Date.now()) {
  const age = now - createdAt.getTime();
  return authorId === userId && age >= 0 && age < HELP_EDIT_MS;
}
export function canReopenHelpTicket(status: string, closedAt: Date | null, now = Date.now()) {
  const age = closedAt ? now - closedAt.getTime() : -1;
  return status === 'CLOSED' && age >= 0 && age <= HELP_REOPEN_MS;
}
export function helpTitle(text: string, hasAttachments: boolean) {
  return text.trim().replace(/\s+/g, ' ').slice(0, 100) || (hasAttachments ? 'Обращение с вложениями' : 'Обращение');
}
// Never accept caller-provided MIME as proof. Active formats are not previewed.
export function detectHelpFile(bytes: Buffer): { mimeType: string; kind: string } | null {
  if(!bytes.length) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mimeType: 'image/png', kind: 'IMAGE' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mimeType: 'image/jpeg', kind: 'IMAGE' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mimeType: 'image/webp', kind: 'IMAGE' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return { mimeType: 'audio/wav', kind: 'AUDIO' };
  if (bytes.toString('ascii', 0, 4) === 'OggS') return { mimeType: 'audio/ogg', kind: 'AUDIO' };
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return { mimeType: 'audio/mpeg', kind: 'AUDIO' };
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && ['M4A ', 'M4B '].includes(bytes.toString('ascii', 8, 12))) return { mimeType: 'audio/mp4', kind: 'AUDIO' };
  if (bytes.toString('ascii',4,8)==='ftyp' && bytes.includes(Buffer.from('soun')) && !bytes.includes(Buffer.from('vide'))) return {mimeType:'audio/mp4',kind:'AUDIO'};
  if (bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163])) && bytes.includes(Buffer.from('A_OPUS')) && !bytes.includes(Buffer.from('V_VP'))) return { mimeType: 'audio/webm', kind: 'AUDIO' };
  if (bytes.toString('ascii', 0, 5) === '%PDF-') return { mimeType: 'application/pdf', kind: 'FILE' };
  // Documents remain downloads only; no server parsing, execution or AI processing.
  if (bytes.subarray(0, 4).equals(Buffer.from([80,75,3,4]))) return { mimeType: 'application/zip', kind: 'FILE' };
  if (bytes.subarray(0, 8).equals(Buffer.from([208,207,17,224,161,177,26,225]))) return { mimeType: 'application/octet-stream', kind: 'FILE' };
  if (!bytes.includes(0) && !bytes.toString('utf8').includes('\uFFFD') && !/^\s*(?:<!doctype|<html|<svg|<script)/i.test(bytes.toString('utf8', 0, 512))) return { mimeType: 'text/plain', kind: 'FILE' };
  return null;
}
