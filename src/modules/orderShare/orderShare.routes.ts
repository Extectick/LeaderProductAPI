import express from 'express';
import { randomUUID } from 'node:crypto';
import prisma from '../../prisma/client';
import { authenticateToken, authorizePermissions, type AuthRequest } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import { authorizeServiceAccess } from '../../middleware/serviceAccess';
import { downloadBuffer } from '../../storage/minio';
import { isShareToken, shareTokenHash } from './orderShare.model';
import { getOwnedShare, presentOwnedShare, publishOrder, resolvePublicShare, sharedImageKey, sharingEnabled } from './orderShare.service';
import { logShareError, presentShareError, type ShareOperation } from './orderShare.errors';

const unavailable = { ok: false, message: 'Ссылка недоступна. Обратитесь к менеджеру.' };
const noStore: express.RequestHandler = (_req, res, next) => {
  res.locals.shareRequestId = randomUUID();
  res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff', 'Access-Control-Expose-Headers': 'ETag, X-Request-ID',
    'X-Request-ID': res.locals.shareRequestId });
  if (!sharingEnabled()) { res.status(404).json(unavailable); return; }
  next();
};
const handleError = (req: AuthRequest, res: express.Response, error: unknown, operation: ShareOperation) => {
  logShareError(error, { operation, requestId: res.locals.shareRequestId,
    orderGuid: (req.params as { guid?: string }).guid, ownerId: req.user?.userId });
  const { status, message, code } = presentShareError(error);
  res.status(status).json({ ok: false, message, code, requestId: res.locals.shareRequestId });
};

export const orderShareManagerRouter = express.Router();
orderShareManagerRouter.use(authenticateToken, checkUserStatus, authorizeServiceAccess('client_orders'), authorizePermissions(['manage_client_orders']), noStore);
orderShareManagerRouter.get('/:guid/share', async (req: AuthRequest, res) => {
  try {
    const link = await getOwnedShare(String((req.params as any).guid), req.user!.userId);
    res.json({ ok: true, data: link ? presentOwnedShare(link) : null });
  } catch (error) { handleError(req, res, error, 'MANAGER_READ'); }
});
orderShareManagerRouter.post('/:guid/share', async (req: AuthRequest, res) => {
  try {
    const guid = String((req.params as any).guid);
    if (guid.length > 100 || !guid.length) { res.status(400).json({ ok: false, message: 'Некорректный заказ' }); return; }
    const data = await publishOrder(guid, req.user!.userId, (req.body as { rotate?: boolean })?.rotate === true);
    res.json({ ok: true, data });
  } catch (error) { handleError(req, res, error, 'CREATE'); }
});
orderShareManagerRouter.delete('/:guid/share', async (req: AuthRequest, res) => {
  try {
    await prisma.orderShareLink.updateMany({ where: { ownerId: req.user!.userId, orderGuid: String((req.params as any).guid) }, data: { revokedAt: new Date() } });
    res.json({ ok: true, data: null });
  } catch (error) { handleError(req, res, error, 'REVOKE'); }
});

export const publicOrderRouter = express.Router();
publicOrderRouter.use(noStore);
// A bounded per-process safety net; edge limits are also applied by nginx.
const windows = new Map<string, { expires: number; count: number }>();
publicOrderRouter.use((req, res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (!isShareToken(token)) { res.status(410).json(unavailable); return; }
  const key = shareTokenHash(token);
  const now = Date.now();
  if (windows.size > 5000) for (const [id, window] of windows) if (window.expires <= now) windows.delete(id);
  let window = windows.get(key);
  if (!window || window.expires <= now) {
    if (windows.size >= 10000 && !window) { res.status(429).json({ ok: false, message: 'Попробуйте позже' }); return; }
    window = { expires: now + 60000, count: 0 }; windows.set(key, window);
  }
  if (++window.count > 600) { res.set('Retry-After', '60').status(429).json({ ok: false, message: 'Попробуйте позже' }); return; }
  res.locals.shareToken = token;
  next();
});
publicOrderRouter.get('/', async (req, res) => {
  try {
    const result = await resolvePublicShare(res.locals.shareToken);
    res.set('ETag', result.etag);
    if (req.headers['if-none-match'] === result.etag) { res.status(304).end(); return; }
    res.json({ ok: true, data: result.data });
  } catch (error) { handleError(req, res, error, 'PUBLIC_READ'); }
});
publicOrderRouter.get('/images/:id', async (req, res) => {
  try {
    const key = await sharedImageKey(res.locals.shareToken, String(req.params.id));
    if (!key) { res.status(404).end(); return; }
    const file = await downloadBuffer(key);
    if (!/^image\/(webp|png|jpeg)$/.test(file.contentType) || file.body.length > 5 * 1024 * 1024) { res.status(404).end(); return; }
    res.type(file.contentType).send(file.body);
  } catch (error) { handleError(req, res, error, 'IMAGE_READ'); }
});
