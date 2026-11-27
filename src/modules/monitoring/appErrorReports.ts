import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authenticateToken, authorizeRoles, type AuthRequest } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import prisma from '../../prisma/client';

const project = 'leaderproduct-app-errors';
const kind = z.enum(['maximum_update_depth', 'type_error', 'range_error', 'reference_error', 'syntax_error', 'error', 'unknown', 'java_exception', 'native_crash', 'anr', 'slow_operation']);
const source = z.enum(['react_boundary', 'global_js', 'captured', 'android_native', 'performance']);
const screen = z.enum(['orders', 'help', 'profile', 'auth', 'services', 'home', 'admin', 'unknown']);
const stage = z.enum(['unknown', 'orders', 'editor-header', 'editor-items', 'product-picker', 'reference-picker', 'line-editor', 'linked-order', 'filters', 'web-workspace']);
const titles: Record<z.infer<typeof kind>, string> = {
  maximum_update_depth: 'Maximum update depth exceeded',
  type_error: 'TypeError',
  range_error: 'RangeError',
  reference_error: 'ReferenceError',
  syntax_error: 'SyntaxError',
  error: 'Error',
  unknown: 'Unknown error',
  java_exception: 'Android Java exception',
  native_crash: 'Android native crash',
  anr: 'Application not responding',
  slow_operation: 'Slow order interaction',
};
const version = z.string().max(40).regex(/^\d+(?:\.\d+){0,3}$/);
const component = z.string().max(100).regex(/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/);
const javaClass = z.string().max(160).regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/);
const javaFrame = z.string().max(160).regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?::\d{1,9})?$/);
const pickerAction = z.enum([
  'picker_open', 'search_changed', 'search_cleared', 'page_load', 'page_append',
  'quantity_plus', 'quantity_minus', 'quantity_input', 'editor_open', 'editor_close',
]);
const nativeEvidence = z.strictObject({
  androidApi: z.number().int().min(1).max(999),
  exceptionClass: javaClass.optional(),
  frames: z.array(javaFrame).max(16).optional(),
  signal: z.number().int().min(0).max(127).optional(),
  exitReason: z.number().int().min(0).max(255).optional(),
});
const schema = z.strictObject({
  eventId: z.uuidv4(),
  occurredAt: z.iso.datetime(),
  kind, source, screen, stage,
  platform: z.enum(['android', 'ios', 'web']),
  appVersion: version.optional(),
  buildNumber: z.string().regex(/^\d{1,12}$/).optional(),
  runtimeVersion: version.optional(),
  otaUpdateId: z.uuid().optional(),
  components: z.array(component).max(32),
  jsFrames: z.array(z.string().regex(/^\d{1,9}:\d{1,9}$/)).max(24),
  pickerActions: z.array(pickerAction).min(1).max(12).optional(),
  nativeEvidence: nativeEvidence.optional(),
  timing: z.strictObject({
    metric: z.enum(['js_event_loop', 'input_dispatch', 'draft_read_all', 'draft_read_changed']),
    durationMs: z.number().int().min(500).max(120000),
  }).optional(),
}).refine(report => {
  const androidCrash = report.source === 'android_native';
  const nativeKind = ['java_exception', 'native_crash', 'anr'].includes(report.kind);
  const measured = report.kind === 'slow_operation';
  if (report.pickerActions && (report.platform !== 'android' || report.screen !== 'orders'
    || (report.source !== 'react_boundary' && report.source !== 'global_js'))) return false;
  return measured === (report.source === 'performance') && measured === Boolean(report.timing) &&
    (!measured || (report.platform === 'android' && report.screen === 'orders' && !report.components.length && !report.jsFrames.length))
    && androidCrash === nativeKind && androidCrash === Boolean(report.nativeEvidence)
    && (!androidCrash || report.platform === 'android');
});

export const appErrorReportsRouter = express.Router();
appErrorReportsRouter.use((_req, res, next) => {
  if (process.env.APP_ERROR_REPORTING_ENABLED !== 'true') return res.sendStatus(404);
  res.set('Cache-Control', 'no-store');
  next();
});
appErrorReportsRouter.use(authenticateToken, checkUserStatus);

appErrorReportsRouter.post('/', express.json({ limit: '8kb', inflate: false }), async (req: AuthRequest, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: 'INVALID_APP_ERROR_REPORT' });
  const report = parsed.data;
  const occurredAt = new Date(report.occurredAt);
  const age = Date.now() - occurredAt.getTime();
  if (age < -10 * 60_000 || age > 8 * 86400000) return res.status(400).json({ code: 'INVALID_REPORT_TIME' });

  const userId = String(req.user!.userId);
  // AppCrashEvent uses a 32-character key. Scope retries to the authenticated account.
  const eventId = createHash('sha256').update(userId + ':' + report.eventId.toLowerCase()).digest('hex').slice(0, 32);
  const env = process.env.APP_ERROR_REPORTING_ENVIRONMENT;
  const environment = env === 'development' || env === 'production' ? env : 'unknown';
  const details = JSON.stringify({ eventId: report.eventId.toLowerCase(), kind: report.kind, source: report.source,
    stage: report.stage, components: report.components, jsFrames: report.jsFrames, pickerActions: report.pickerActions,
    nativeEvidence: report.nativeEvidence, timing: report.timing });
  const level = report.timing ? 'warning' : 'error';
  try {
    const accepted = await prisma.$transaction(async tx => {
      // Serialize the rate check and insert per user across all API replicas.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${project + ':' + userId}, 0))`;
      const [budget] = await tx.$queryRaw<{ duplicate: boolean; exhausted: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "AppCrashEvent" WHERE project = ${project} AND "eventId" = ${eventId}
        ) AS duplicate, EXISTS (
          SELECT 1 FROM "AppCrashEvent" WHERE project = ${project} AND "reportedUserId" = ${userId}
            AND level = ${level} AND "receivedAt" > CURRENT_TIMESTAMP - INTERVAL '1 hour' OFFSET ${report.timing ? 3 : 11} LIMIT 1
        ) AS exhausted`;
      if (budget.duplicate) return true;
      if (budget.exhausted) return false;
      await tx.$executeRaw`
        INSERT INTO "AppCrashEvent" (id, project, "eventId", environment, "occurredAt", title, level, platform,
          "reportedUserId", "appVersion", "buildNumber", "otaUpdateId", "runtimeVersion", screen, details)
        VALUES (${randomUUID()}, ${project}, ${eventId}, ${environment}, ${occurredAt}, ${titles[report.kind]},
          ${level}, ${report.platform}, ${userId}, ${report.appVersion ?? null}, ${report.buildNumber ?? null},
          ${report.otaUpdateId?.toLowerCase() ?? null}, ${report.runtimeVersion ?? null}, ${report.screen}, ${details}::jsonb)
        ON CONFLICT (project, "eventId") DO NOTHING`;
      return true;
    }, { isolationLevel: 'ReadCommitted' });
    if (!accepted) return res.set('Retry-After', '3600').sendStatus(429);
    return res.sendStatus(204);
  } catch {
    console.warn('[monitoring] app error report storage unavailable');
    return res.sendStatus(503);
  }
});

// A keyset cursor remains valid when rows on an earlier page expire.
const paginationCursor = z.string().max(90).transform((value, ctx) => {
  const [time, id, ...rest] = value.split('|');
  if (rest.length || !z.iso.datetime().safeParse(time).success || !z.uuidv4().safeParse(id).success) {
    ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
    return z.NEVER;
  }
  return { time: new Date(time), id };
});
const listQuery = z.strictObject({
  limit: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().min(1).max(100)).optional(),
  cursor: paginationCursor.optional(),
  kind: kind.optional(), source: source.optional(), screen: screen.optional(), stage: stage.optional(),
  otaUpdateId: z.uuid().optional(), eventId: z.uuidv4().optional(),
});

appErrorReportsRouter.get('/', authorizeRoles(['admin', 'administrator']), async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return res.sendStatus(400);
  const query = parsed.data;
  const limit = query.limit ?? 30;
  const filters = [Prisma.sql`project = ${project}`];
  if (query.screen) filters.push(Prisma.sql`screen = ${query.screen}`);
  if (query.kind) filters.push(Prisma.sql`details->>'kind' = ${query.kind}`);
  if (query.source) filters.push(Prisma.sql`details->>'source' = ${query.source}`);
  if (query.stage) filters.push(Prisma.sql`details->>'stage' = ${query.stage}`);
  if (query.eventId) filters.push(Prisma.sql`details->>'eventId' = ${query.eventId.toLowerCase()}`);
  if (query.otaUpdateId) filters.push(Prisma.sql`"otaUpdateId" = ${query.otaUpdateId.toLowerCase()}`);
  if (query.cursor) filters.push(Prisma.sql`("occurredAt", id) < (${query.cursor.time}, ${query.cursor.id})`);
  try {
    const rows = await prisma.$queryRaw<{id: string; occurredAt: Date}[]>`
      SELECT id, title, "occurredAt", "receivedAt", screen, platform, environment, "reportedUserId", "appVersion",
        "buildNumber", "runtimeVersion", "otaUpdateId", details
      FROM "AppCrashEvent" WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY "occurredAt" DESC, id DESC LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > limit ? last.occurredAt.toISOString() + '|' + last.id : null;
    return res.json({ items, nextCursor });
  } catch {
    console.warn('[monitoring] app error reports unavailable');
    return res.sendStatus(503);
  }
});

// Keep malformed or oversized payloads out of global debug/error handlers as well.
appErrorReportsRouter.use(((error, _req, res, _next) => {
  const status = [400, 413, 415].includes(error?.status) ? error.status : 500;
  res.status(status).json({ code: 'INVALID_APP_ERROR_REPORT' });
}) as express.ErrorRequestHandler);
