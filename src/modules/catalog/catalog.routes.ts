import express from 'express';
import { authenticateToken, authorizePermissions, type AuthRequest } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import { authorizeServiceAccess } from '../../middleware/serviceAccess';
import { errorResponse, ErrorCodes, successResponse } from '../../utils/apiResponse';
import { catalogChangesQuerySchema, catalogSnapshotQuerySchema } from './catalog.schemas';
import { CatalogError, getCatalogChanges, getCatalogManifest, getCatalogSnapshot } from './catalog.service';

const router = express.Router();

router.use(authenticateToken, checkUserStatus, authorizeServiceAccess('client_orders'));
router.use(authorizePermissions(['view_client_orders']));

function handleError(res: express.Response, error: unknown) {
  if (error instanceof CatalogError) {
    return res.status(error.status).json(errorResponse(error.message, ErrorCodes.CONFLICT));
  }
  console.error('[catalog] request failed', error);
  return res.status(500).json(errorResponse('Не удалось синхронизировать каталог', ErrorCodes.INTERNAL_ERROR));
}

router.get('/manifest', async (_req: AuthRequest, res) => {
  try {
    const manifest = await getCatalogManifest();
    const etag = `W/\"catalog-${manifest.epoch}-${manifest.revision}\"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (_req.headers['if-none-match'] === etag) return res.status(304).end();
    return res.json(successResponse(manifest, 'Состояние каталога'));
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/snapshot', async (req: AuthRequest, res) => {
  const parsed = catalogSnapshotQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(parsed.error.issues[0]?.message ?? 'Некорректный запрос', ErrorCodes.VALIDATION_ERROR));
  }
  try {
    return res.json(successResponse(await getCatalogSnapshot(parsed.data), 'Страница каталога'));
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/changes', async (req: AuthRequest, res) => {
  const parsed = catalogChangesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(parsed.error.issues[0]?.message ?? 'Некорректный запрос', ErrorCodes.VALIDATION_ERROR));
  }
  try {
    return res.json(successResponse(await getCatalogChanges(parsed.data), 'Изменения каталога'));
  } catch (error) {
    return handleError(res, error);
  }
});

export default router;
