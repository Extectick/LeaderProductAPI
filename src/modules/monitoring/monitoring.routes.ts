import express from 'express';
import prisma from '../../prisma/client';
import { authenticateToken, authorizeRoles } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import { parseSentryServiceHook, verifySentrySignature } from './crashEvents';

export const sentryWebhookRouter = express.Router();
export const crashEventsRouter = express.Router();

// Feature is off by default. No raw payload passes through general request logging.
const enabled = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (process.env.APP_CRASH_REPORTING_ENABLED !== 'true') return res.sendStatus(404);
  return next();
};

// Separate budget: ingestion must not consume the shared login/tracking IP limiter.
let hookWindowStarted = 0;
let hookRequests = 0;
const consumeHookBudget = (res: express.Response): boolean => {
  const now = Date.now();
  if (now - hookWindowStarted >= 60_000) {
    hookWindowStarted = now;
    hookRequests = 0;
  }
  if (++hookRequests > 300) {
    res.set('Retry-After', '60').sendStatus(429);
    return false;
  }
  return true;
};

sentryWebhookRouter.post('/', enabled,
  express.raw({ type: 'application/json', limit: '512kb', inflate: false }), async (req, res) => {
    const secret = process.env.SENTRY_WEBHOOK_SECRET || '';
    const project = process.env.SENTRY_PROJECT_SLUG || '';
    const environment = process.env.SENTRY_EXPECTED_ENVIRONMENT || '';
    if (secret.length < 32 || !project || !environment) return res.sendStatus(503);
    if (!Buffer.isBuffer(req.body) || !verifySentrySignature(req.body, req.get('X-ServiceHook-Signature') || '', secret)) {
      return res.sendStatus(401);
    }
    // Invalid signatures cannot exhaust the trusted sender's delivery budget.
    if (!consumeHookBudget(res)) return;
    let data: ReturnType<typeof parseSentryServiceHook>;
    try {
      data = parseSentryServiceHook(JSON.parse(req.body.toString('utf8')), project, environment);
    } catch {
      return res.status(400).json({ code: 'INVALID_SENTRY_EVENT' });
    }
    // ACK only after durable DB write. Unique key also makes replay harmless.
    // Delayed/offline events are valid; webhook timestamp is not a freshness authority.
    try {
      await prisma.appCrashEvent.upsert({
        where: { project_eventId: { project: data.project, eventId: data.eventId } },
        create: data, update: {},
      });
      return res.sendStatus(204);
    } catch {
      console.warn('[monitoring] crash event persistence failed');
      return res.sendStatus(503);
    }
  });

crashEventsRouter.get('/', enabled, authenticateToken, checkUserStatus, authorizeRoles(['admin', 'administrator']),
  async (req: express.Request, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 30)));
      const cursor = typeof req.query.cursor === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.cursor) ? req.query.cursor : undefined;
      const rows = await prisma.appCrashEvent.findMany({
        take: limit + 1, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      return res.json({ items: rows.slice(0, limit), nextCursor: hasMore ? rows[limit - 1].id : null });
    } catch (error) { return next(error); }
  });
