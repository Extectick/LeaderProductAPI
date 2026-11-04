'use strict';

// Heuristic minimization, not a promise of complete anonymization. Names and
// business identifiers in prose need a human privacy review before wider use.
const SECRET = /(?:(?:уч[её]тк[ауеи]|уч[её]тн(?:ая|ую|ой|ые|ых)\s+(?:запис[ьи]|данные|данных)|credentials)\s*[:=]\s*\S+|\b[A-Za-z0-9_.-]+@(?:\d{1,3}\.){3}\d{1,3}\s+\S{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[\w.+/=-]{6,}|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:парол[ьяеи]|password|passwd|pwd|логин|login|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|cookie|client[ _-]?secret|код\s+подтверждения)\s*[:=]\s*\S+|(?:мой\s+пароль|my\s+password)\s+\S+|[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@)/iu;
const CONTACT = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:\+\d[\d ()-]{8,}\d)|\b\d{11,19}\b|\b(?:https?|wss?|ftp|s3|file):\/\/[^\s<>"']+|\\\\[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|ru|org|net|io|local|internal)\b)/iu;
const CREDENTIAL_REQUEST = /(?:(?:пришлите|укажите|введите|напишите|отправьте|сообщите|назовите|нужен|нужны|send|enter|provide|need).{0,100}(?:парол|логин|уч[её]т|credentials|password|login)|(?:логин|login).{0,40}(?:парол|password)|(?:пароль|password|логин|login)\s*\?)/iu;
const CREDENTIAL_PAIR = /^[A-Za-z0-9_.@\\/-]{1,128}\s+\S{4,128}$/u;
const PERSONAL = /(?:\b[78](?:[ ()-]*\d){10}\b|[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,}(?:\s+[А-ЯЁ][а-яё]{2,})?)/u;
const FLAGS = new Set(['credentials_suppressed', 'contact_redacted', 'text_truncated', 'messages_truncated', 'jobs_truncated']);
const clean = text => text.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
const isPlainObject = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function failure() { const error = new Error('HELP_LEARNING_INVALID_SNAPSHOT'); error.code = error.message; throw error; }
function positive(value) { if (!Number.isSafeInteger(value) || value <= 0) failure(); return value; }
function timestamp(value, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) failure();
  return new Date(value).toISOString();
}
function containsSensitiveText(text) {
  return typeof text !== 'string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text) || SECRET.test(clean(text)) || CONTACT.test(clean(text)) || PERSONAL.test(clean(text));
}
function sanitizeSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || !/^[a-f0-9]{64}$/i.test(snapshot.sourceVersion || '') || !['OPEN', 'CLOSED'].includes(snapshot.status) ||
      typeof snapshot.itRequested !== 'boolean' || typeof snapshot.truncated !== 'boolean' || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.jobs)) failure();
  if (!Number.isSafeInteger(snapshot.lastEventId) || snapshot.lastEventId < 0) failure();
  const flags = new Set((Array.isArray(snapshot.privacyFlags) ? snapshot.privacyFlags : []).filter(flag => FLAGS.has(flag)));
  let truncated = snapshot.truncated, remaining = 160000;
  const ids = new Set(), sequences = new Set();
  const input = snapshot.messages.filter(message => message?.kind !== 'ASSISTANT_PROGRESS');
  if (input.length > 80) { flags.add('messages_truncated'); truncated = true; }
  const credentialContext = input.some(message => typeof message?.text === 'string' && CREDENTIAL_REQUEST.test(clean(message.text)));
  const messages = input.slice(-80).map(message => {
    if (!isPlainObject(message) || typeof message.text !== 'string' || !/^[A-Z_]{1,24}$/.test(message.authorRole || '') || !/^[A-Z_]{1,32}$/.test(message.kind || '')) failure();
    const id = positive(message.id), sequence = positive(message.sequence);
    if (ids.has(id) || sequences.has(sequence)) failure(); ids.add(id); sequences.add(sequence);
    if (message.rating !== null && (!Number.isInteger(message.rating) || message.rating < 0 || message.rating > 5)) failure();
    let text = clean(message.text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    if (SECRET.test(text) || credentialContext && CREDENTIAL_PAIR.test(text.trim())) {
      text = '[СООБЩЕНИЕ С УЧЁТНЫМИ ДАННЫМИ СКРЫТО]'; flags.add('credentials_suppressed'); truncated = true;
    } else {
      const redacted = text.replace(new RegExp(CONTACT.source, 'giu'), '[КОНТАКТ ИЛИ АДРЕС СКРЫТ]')
        .replace(new RegExp(PERSONAL.source, 'gu'), '[ПЕРСОНАЛЬНЫЕ ДАННЫЕ СКРЫТЫ]');
      if (redacted !== text) flags.add('contact_redacted'); text = redacted;
    }
    const limit = Math.min(4000, remaining);
    if (text.length > limit) { text = text.slice(0, limit); flags.add('text_truncated'); truncated = true; }
    remaining -= text.length;
    return { id, sequence, authorRole: message.authorRole, kind: message.kind, text, rating: message.rating, createdAt: timestamp(message.createdAt) };
  }).sort((a, b) => a.sequence - b.sequence);
  if (snapshot.jobs.length > 8) { flags.add('jobs_truncated'); truncated = true; }
  const jobs = snapshot.jobs.slice(0, 8).map(job => {
    if (!isPlainObject(job) || !/^[A-Z_]{1,24}$/.test(job.status || '') || !/^[a-z0-9_-]{1,40}$/.test(job.provider || '') ||
        job.errorCode !== null && !/^[A-Z0-9_]{1,100}$/.test(job.errorCode || '')) failure();
    return { status: job.status, errorCode: job.errorCode, provider: job.provider, completedAt: timestamp(job.completedAt, true) };
  });
  return { ticketId: positive(snapshot.ticketId), sourceVersion: snapshot.sourceVersion.toLowerCase(), status: snapshot.status,
    closedAt: timestamp(snapshot.closedAt, true), itRequested: snapshot.itRequested, updatedAt: timestamp(snapshot.updatedAt),
    lastEventId: snapshot.lastEventId, truncated, messages, jobs, privacyFlags: [...flags].sort() };
}
module.exports = { sanitizeSnapshot, containsSensitiveText, isPlainObject };
