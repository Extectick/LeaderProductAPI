import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class KnowledgeError extends Error {
  constructor(public status: number, public code: string, message: string = code) { super(message); }
}
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 500000;
export const SOURCE_FRESH_MS = 10 * 60 * 1000;
export const SCAN_INTERVAL_MS = 60000;
export const MAX_SCAN_ENTRIES = 10000;
export const MAX_SCAN_FOLDERS = 1000;
export type KnowledgeConfig = {
  key: string; name: string; url: string; user: string; password: string;
  root: string; fingerprint: string;
};
export const knowledgeEnabled = () => process.env.KNOWLEDGE_ENABLED === 'true';
// Opt-in per environment. Folder editors approve content by placing it in COMPANY.
export const folderPublicationEnabled = () => knowledgeEnabled() && process.env.KNOWLEDGE_PUBLICATION_MODE === 'folder';
export function knowledgeConfig(): KnowledgeConfig {
  if (!knowledgeEnabled()) throw new KnowledgeError(503, 'KNOWLEDGE_DISABLED');
  const url = new URL(process.env.KNOWLEDGE_NEXTCLOUD_URL || 'https://invalid.invalid');
  const user = process.env.KNOWLEDGE_NEXTCLOUD_USER || '';
  const password = process.env.KNOWLEDGE_NEXTCLOUD_PASSWORD_FILE
    ? readFileSync(process.env.KNOWLEDGE_NEXTCLOUD_PASSWORD_FILE, 'utf8').trim()
    : process.env.KNOWLEDGE_NEXTCLOUD_PASSWORD || '';
  const key = process.env.KNOWLEDGE_SOURCE_KEY || '';
  const root = process.env.KNOWLEDGE_NEXTCLOUD_ROOT || 'База знаний';
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || !user || !password || !/^[a-z0-9][a-z0-9_-]{2,80}$/.test(key) ||
      root.split('/').some(x => !x || x === '.' || x === '..') || /[\\\x00-\x1f]/.test(root) || /[/:\\\x00-\x1f]/.test(user)) {
    throw new KnowledgeError(503, 'KNOWLEDGE_CONFIGURATION_INVALID');
  }
  const origin = url.origin;
  return { key, name: 'База знаний компании', url: origin, user, password, root,
    fingerprint: createHash('sha256').update(JSON.stringify([origin, user, root])).digest('hex') };
}
export function documentSection(path: string) {
  const root = path.split('/')[0];
  return root === 'Материалы компании' ? 'COMPANY' : root === 'Рабочая область ИИ' ? 'AI_WORKSPACE' : root === 'Архив' ? 'ARCHIVE' : 'OTHER';
}
export function supportedExtension(path: string): string | null {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ['md', 'txt', 'pdf', 'docx'].includes(extension) ? extension : null;
}
export function safeErrorCode(error: unknown) {
  return error instanceof KnowledgeError ? error.code : 'KNOWLEDGE_OPERATION_FAILED';
}
