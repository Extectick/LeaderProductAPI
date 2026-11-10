import { z } from 'zod';

export const HELP_AI_FILE_MAX_BYTES = 32 * 1024;
export const HELP_AI_FILES_MAX_BYTES = 48 * 1024;
export const helpAIFileSchema = z.object({
  name: z.string().trim().min(4).max(100),
  content: z.string().min(1).max(16000),
}).strict();
export type HelpAIFile = z.infer<typeof helpAIFileSchema>;
const mediaTypes: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
};

/** These are bounded text exports, never remote URLs, archives or executable files. */
export function validateHelpAIFiles(value: unknown): Array<HelpAIFile & { mimeType: string; bytes: Buffer }> {
  const parsed = z.array(helpAIFileSchema).max(2).parse(value ?? []);
  const seen = new Set<string>();
  let total = 0;
  return parsed.map(file => {
    if (!/^[\p{L}\p{N} _().-]+$/u.test(file.name) || file.name.startsWith('.') || file.name.includes('..') ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(file.name)) throw new Error('HELP_AI_INVALID_FILE');
    const extension = file.name.split('.').slice(-1)[0]?.toLowerCase() || '';
    const mimeType = mediaTypes[extension];
    if (!mimeType || seen.has(file.name.toLowerCase())) throw new Error('HELP_AI_INVALID_FILE');
    seen.add(file.name.toLowerCase());
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(file.content)) throw new Error('HELP_AI_INVALID_FILE');
    const bytes = Buffer.from(file.content, 'utf8');
    if (bytes.toString('utf8') !== file.content) throw new Error('HELP_AI_INVALID_FILE');
    total += bytes.length;
    if (bytes.length > HELP_AI_FILE_MAX_BYTES || total > HELP_AI_FILES_MAX_BYTES) throw new Error('HELP_AI_INVALID_FILE');
    if (extension === 'json') { try { JSON.parse(file.content); } catch { throw new Error('HELP_AI_INVALID_FILE'); } }
    return { ...file, mimeType, bytes };
  });
}

/** File-related drafts are held until files have actually been saved and fenced. */
export function helpAIFileContext(messages: Array<{ role: string; text: string }>) {
  return messages.some(message => message.role === 'user' && /файл|вложени|(?:^|\W)(?:txt|csv|json|markdown|md)(?:$|\W)|выгруз|скача/iu.test(message.text));
}

export function claimsSavedHelpAIFile(text: string) {
  return /sandbox:|(?:^|[.!?\n]\s*)(?:я\s+)?(?:прикрепил[а]?|прикрепляю|отправил[а]?)\s+(?:файл|документ)|(?:вот|готовый|готовые)\s+[^\n.!?]{0,60}файл|(?:файл|файлы)\s+(?:готов|прикрепл[её]н|отправлен)|attached\s+file/iu.test(text);
}

export function requestsHelpAIFile(messages: Array<{ role: string; text: string }>) {
  const text = messages.slice().reverse().find(message => message.role === 'user')?.text || '';
  if (/\b(?:txt|csv|json|markdown|md)\b|текстов[\p{L}]*\s+файл/iu.test(text) === false ||
      /(?:^|\s)(?:не\s+(?:надо|нужно|хочу|присыла|отправ|созда)|как\s+(?:мне\s+)?(?:созда|сдела|сохрани|отправ|скача|сформир|экспортир))/iu.test(text)) return false;
  return /пришл[иь]|прислать|отправ(?:ь|ить|ьте)|созда(?:й|ть|йте)|сдела(?:й|ть|йте)|подготов(?:ь|ить|ьте)|сохрани(?:ть|те)?|выгруз(?:и|ить|ите)|(?:сформир|экспортир)(?:уй|уйте|овать)|скача(?:ть|й|йте)|(?:^|\s)дай(?:те)?(?:\s|$)/iu.test(text);
}
