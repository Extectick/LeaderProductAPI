import express from 'express';
import { ZodError } from 'zod';
import { authenticateToken, authorizePermissions, type AuthRequest } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import { authorizeServiceAccess } from '../../middleware/serviceAccess';
import { errorResponse, ErrorCodes, successResponse } from '../../utils/apiResponse';
import {
  clientOrderCancelSchema,
  clientOrderCreateSchema,
  clientOrderSubmitSchema,
  clientOrderUpdateSchema,
  clientOrdersListQuerySchema,
  clientOrdersProductsQuerySchema,
  clientOrdersReferenceDataQuerySchema,
  orderGuidParamsSchema,
} from './clientOrders.schemas';
import {
  cancelClientOrder,
  ClientOrdersError,
  createClientOrder,
  getClientOrderByGuid,
  getClientOrdersProducts,
  getClientOrdersReferenceData,
  listClientOrders,
  submitClientOrder,
  updateClientOrder,
} from './clientOrders.service';

const router = express.Router();

router.use(authenticateToken, checkUserStatus, authorizeServiceAccess('client_orders'));

const handleError = (res: express.Response, err: unknown, fallbackMessage: string) => {
  if (err instanceof ClientOrdersError) {
    return res.status(err.status).json(errorResponse(err.message, err.code));
  }
  if (err instanceof ZodError) {
    return res.status(400).json(errorResponse(err.message, ErrorCodes.VALIDATION_ERROR));
  }
  console.error(fallbackMessage, err);
  return res.status(500).json(errorResponse(fallbackMessage, ErrorCodes.INTERNAL_ERROR));
};

router.get(
  '/',
  authorizePermissions(['view_client_orders']),
  async (req: AuthRequest, res) => {
    const parsed = clientOrdersListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
    }

    try {
      const result = await listClientOrders(parsed.data);
      return res.json(successResponse(result.items, 'Список заказов клиентов', {
        total: result.total,
        count: result.items.length,
      }));
    } catch (err) {
      return handleError(res, err, 'Ошибка получения списка заказов клиентов');
    }
  }
);

router.get(
  '/reference-data',
  authorizePermissions(['view_client_orders']),
  async (req: AuthRequest, res) => {
    const parsed = clientOrdersReferenceDataQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
    }

    try {
      const result = await getClientOrdersReferenceData(parsed.data);
      return res.json(successResponse(result, 'Справочники для заказов клиентов'));
    } catch (err) {
      return handleError(res, err, 'Ошибка получения справочников заказов клиентов');
    }
  }
);

router.get(
  '/products',
  authorizePermissions(['view_client_orders']),
  async (req: AuthRequest, res) => {
    const parsed = clientOrdersProductsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
    }

    try {
      const result = await getClientOrdersProducts(parsed.data);
      return res.json(successResponse(result.items, 'Номенклатура для заказа клиента', {
        total: result.total,
        count: result.items.length,
      }));
    } catch (err) {
      return handleError(res, err, 'Ошибка получения номенклатуры для заказа клиента');
    }
  }
);

router.get(
  '/:guid',
  authorizePermissions(['view_client_orders']),
  async (req: AuthRequest, res) => {
    const parsed = orderGuidParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
    }

    try {
      const result = await getClientOrderByGuid(parsed.data.guid);
      return res.json(successResponse(result, 'Карточка заказа клиента'));
    } catch (err) {
      return handleError(res, err, 'Ошибка получения карточки заказа клиента');
    }
  }
);

router.post(
  '/',
  authorizePermissions(['manage_client_orders']),
  async (req: AuthRequest, res) => {
    const parsed = clientOrderCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
    }

    try {
      const result = await createClientOrder(req.user!.userId, parsed.data);
      return res.status(201).json(successResponse(result, 'Черновик заказа клиента создан'));
    } catch (err) {
      return handleError(res, err, 'Ошибка создания заказа клиента');
    }
  }
);

router.patch(
  '/:guid',
  authorizePermissions(['manage_client_orders']),
  async (req: AuthRequest, res) => {
    const params = orderGuidParamsSchema.safeParse(req.params);
    const body = clientOrderUpdateSchema.safeParse(req.body);
    if (!params.success) {
      return res.status(400).json(errorResponse(params.error.message, ErrorCodes.VALIDATION_ERROR));
    }
    if (!body.success) {
      return res.status(400).json(errorResponse(body.error.message, ErrorCodes.VALIDATION_ERROR));
    }

    try {
      const result = await updateClientOrder(params.data.guid, req.user!.userId, body.data);
      return res.json(successResponse(result, 'Заказ клиента обновлен'));
    } catch (err) {
      return handleError(res, err, 'Ошибка обновления заказа клиента');
    }
  }
);

router.post(
  '/:guid/submit',
  authorizePermissions(['manage_client_orders']),
  async (req: AuthRequest, res) => {
    const params = orderGuidParamsSchema.safeParse(req.params);
    const body = clientOrderSubmitSchema.safeParse(req.body);
    if (!params.success) {
      return res.status(400).json(errorResponse(params.error.message, ErrorCodes.VALIDATION_ERROR));
    }
    if (!body.success) {
      return res.status(400).json(errorResponse(body.error.message, ErrorCodes.VALIDATION_ERROR));
    }

    try {
      const result = await submitClientOrder(params.data.guid, req.user!.userId, body.data);
      return res.json(successResponse(result, 'Заказ клиента отправлен в 1С'));
    } catch (err) {
      return handleError(res, err, 'Ошибка отправки заказа клиента в 1С');
    }
  }
);

router.post(
  '/:guid/cancel',
  authorizePermissions(['manage_client_orders']),
  async (req: AuthRequest, res) => {
    const params = orderGuidParamsSchema.safeParse(req.params);
    const body = clientOrderCancelSchema.safeParse(req.body);
    if (!params.success) {
      return res.status(400).json(errorResponse(params.error.message, ErrorCodes.VALIDATION_ERROR));
    }
    if (!body.success) {
      return res.status(400).json(errorResponse(body.error.message, ErrorCodes.VALIDATION_ERROR));
    }

    try {
      const result = await cancelClientOrder(params.data.guid, req.user!.userId, body.data);
      return res.json(successResponse(result, 'Заказ клиента отменен'));
    } catch (err) {
      return handleError(res, err, 'Ошибка отмены заказа клиента');
    }
  }
);

export default router;
