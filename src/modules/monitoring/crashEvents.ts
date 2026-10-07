import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySentrySignature(raw: Buffer, signature: string, secret: string): boolean {
  if (secret.length < 32 || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(raw).digest(), Buffer.from(signature, 'hex'));
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return String(value)
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;&]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, limit) || null;
}

/** Official Sentry service hook v0. Deliberately never persist raw payload/stack/request. */
export function parseSentryServiceHook(body: unknown, project: string, environment: string) {
  const payload = record(body);
  const event = record(payload.event);
  if (record(payload.project).slug !== project) throw new Error('PROJECT_MISMATCH');
  const tags: Record<string, unknown> = {};
  if (Array.isArray(event.tags)) {
    for (const tag of event.tags.slice(0, 100)) {
      if (Array.isArray(tag)) tags[String(tag[0])] = tag[1];
      else if (typeof tag?.key === 'string') tags[tag.key] = tag.value;
    }
  }
  if ((tags.environment ?? event.environment) !== environment) throw new Error('ENVIRONMENT_MISMATCH');
  const eventId = event.eventID ?? event.event_id;
  if (typeof eventId !== 'string' || !/^[a-f0-9]{32}$/i.test(eventId)) throw new Error('INVALID_EVENT_ID');
  const occurredAt = new Date(event.dateCreated ?? (typeof event.timestamp === 'number' ? event.timestamp * 1000 : event.timestamp));
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 86400000) throw new Error('INVALID_EVENT_DATE');
  const contexts = record(event.contexts);
  const userId = record(event.user).id;
  return {
    project, environment, eventId: eventId.toLowerCase(), occurredAt,
    issueId: text(record(payload.group).id, 32),
    title: text(event.title ?? event.message, 300) ?? 'Application error',
    level: text(event.level, 20) ?? 'error',
    platform: text(event.platform, 40),
    release: text(record(event.release).version ?? event.release, 200),
    dist: text(event.dist, 100),
    reportedUserId: /^(?:\d{1,20})$/.test(String(userId)) ? String(userId) : null,
    appVersion: text(tags.app_version, 40),
    buildNumber: text(tags.build_number, 40),
    otaUpdateId: text(tags.ota_update_id, 64),
    runtimeVersion: text(tags.runtime_version, 40),
    screen: text(tags.screen, 160),
    deviceModel: text(record(contexts.device).model, 100),
    osVersion: text(record(contexts.os).version, 40),
  };
}
