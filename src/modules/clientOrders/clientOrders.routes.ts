import express from 'express';
import { ZodError } from 'zod';
import { authenticateToken, authorizePermissions, type AuthRequest } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import { authorizeServiceAccess } from '../../middleware/serviceAccess';
import { errorResponse, ErrorCodes, successResponse } from '../../utils/apiResponse';
import {
  clientOrderCancelSchema,
  clientOrderCopySchema,
  clientOrderCreateSchema,
  clientOrderDefaultsQuerySchema,
  clientOrderProductImagesCleanupSchema,
  clientOrderProductImagesSyncSchema,
  clientOrderReferenceDetailsParamsSchema,
  clientOrderRestoreSchema,
  clientOrderSettingsUpdateSchema,
  clientOrderSubmitSchema,
  clientOrderUnqueueSchema,
  clientOrderUpdateSchema,
  clientOrdersBatchProductsSchema,
  clientOrdersAgreementsQuerySchema,
  clientOrdersContractsQuerySchema,
  clientOrdersCounterpartiesQuerySchema,
  clientOrdersDeliveryAddressesQuerySchema,
  clientOrdersListQuerySchema,
  clientOrdersPriceTypesQuerySchema,
  clientOrdersProductsQuerySchema,
  clientOrdersReferenceDataQuerySchema,
  clientOrdersWarehousesQuerySchema,
  orderGuidParamsSchema,
} from './clientOrders.schemas';
import {
  cancelClientOrder,
  ClientOrdersError,
  cleanupClientOrderProductImages,
  copyClientOrder,
  createClientOrder,
  deleteDraftClientOrder,
  getClientOrderByGuid,
  getClientOrderDefaults,
  getClientOrderProductImagesStatus,
  getClientOrderReferenceDetails,
  getClientOrderSettings,
  getClientOrdersAgreements,
  getClientOrdersContracts,
  getClientOrdersCounterparties,
  getClientOrdersDeliveryAddresses,
  getClientOrdersPriceTypes,
  getClientOrdersProductsByGuids,
  getClientOrdersProducts,
  getClientOrdersReferenceData,
  getClientOrdersWarehouses,
  listClientOrders,
  restoreClientOrder,
  syncClientOrderProductImages,
  submitClientOrder,
  unqueueClientOrder,
  updateClientOrder,
  updateClientOrderSettings,
} from './clientOrders.service';

const router = express.Router();

router.use(authenticateToken, checkUserStatus, authorizeServiceAccess('client_orders'));

const validationMessage = (error: ZodError) => {
  const issue = error.issues[0];
  if (!issue) return 'Проверьте заполнение полей.';
  const field = issue.path.length ? `Поле «${issue.path.join('.')}»: ` : '';
  return `${field}${issue.message}`;
};

const handleError = (res: express.Response, err: unknown, fallbackMessage: string) => {
  if (err instanceof ClientOrdersError) {
    return res.status(err.status).json(errorResponse(err.message, err.code));
  }
  if (err instanceof ZodError) {
    return res.status(400).json(errorResponse(validationMessage(err), ErrorCodes.VALIDATION_ERROR));
  }
  console.error(fallbackMessage, err);
  return res.status(500).json(errorResponse(fallbackMessage, ErrorCodes.INTERNAL_ERROR));
};

const pagedMeta = (total: number, count: number, limit: number, offset: number) => ({
  total,
  count,
  limit,
  offset,
});

router.get('/', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrdersListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await listClientOrders(parsed.data, req.user!.userId);
    return res.json(
      successResponse(
        { items: result.items },
        'Список заказов клиентов',
        {
          ...pagedMeta(result.total, result.items.length, result.limit, result.offset),
          statusCounts: result.statusCounts,
          liveSource: result.liveSource,
        }
      )
    );
  } catch (err) {
    return handleError(res, err, 'Ошибка получения списка заказов клиентов');
  }
});

router.get('/settings', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  try {
    const result = await getClientOrderSettings(req.user!.userId);
    return res.json(successResponse(result, 'Настройки заказов клиентов'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения настроек заказов клиентов');
  }
});

router.put('/settings', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrderSettingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await updateClientOrderSettings(req.user!.userId, parsed.data);
    return res.json(successResponse(result, 'Настройки заказов клиентов обновлены'));
  } catch (err) {
    return handleError(res, err, 'Ошибка обновления настроек заказов клиентов');
  }
});

router.get('/defaults', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrderDefaultsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrderDefaults(req.user!.userId, parsed.data);
    return res.json(successResponse(result, 'Подсказки по умолчанию для заказа клиента'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения подсказок по умолчанию для заказа клиента');
  }
});

router.get('/reference-data', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrdersReferenceDataQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrdersReferenceData(parsed.data);
    return res.json(successResponse(result, 'Справочники для заказов клиентов'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения справочников заказов клиентов');
  }
});

router.get('/reference-details/:kind/:guid', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrderReferenceDetailsParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrderReferenceDetails(parsed.data);
    return res.json(successResponse(result, 'Карточка реквизита заказа клиента'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения карточки реквизита заказа клиента');
  }
});

router.get('/counterparties', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrdersCounterpartiesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrdersCounterparties(parsed.data);
    return res.json(
      successResponse(
        { items: result.items },
        'Контрагенты для заказов клиентов',
        pagedMeta(result.total, result.items.length, result.limit, result.offset)
      )
    );
  } catch (err) {
    return handleError(res, err, 'Ошибка получения контрагентов для заказов клиентов');
  }
});

router.get('/agreements', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrdersAgreementsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrdersAgreements(parsed.data);
    return res.json(
      successResponse(
        { items: result.items },
        'Соглашения для заказов клиентов',
        pagedMeta(result.total, result.items.length, result.limit, result.offset)
      )
    );
  } catch (err) {
    return handleError(res, err, 'Ошибка получения соглашений для заказов клиентов');
  }
});

router.get('/contracts', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrdersContractsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrdersContracts(parsed.data);
    return res.json(
      successResponse(
        { items: result.items },
        'Договоры для заказов клиентов',
        pagedMeta(result.total, result.items.length, result.limit, result.offset)
      )
    );
  } catch (err) {
    return handleError(res, err, 'Ошибка получения договоров для заказов клиентов');
  }
});

router.get('/warehouses', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrdersWarehousesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrdersWarehouses(parsed.data);
    return res.json(
      successResponse(
        { items: result.items },
        'Склады для заказов клиентов',
        pagedMeta(result.total, result.items.length, result.limit, result.offset)
      )
    );
  } catch (err) {
    return handleError(res, err, 'Ошибка получения складов для заказов клиентов');
  }
});

router.get('/delivery-addresses', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrdersDeliveryAddressesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrdersDeliveryAddresses(parsed.data);
    return res.json(
      successResponse(
        { items: result.items },
        'Адреса доставки для заказов клиентов',
        pagedMeta(result.total, result.items.length, result.limit, result.offset)
      )
    );
  } catch (err) {
    return handleError(res, err, 'Ошибка получения адресов доставки для заказов клиентов');
  }
});

router.get('/price-types', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrdersPriceTypesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrdersPriceTypes(parsed.data);
    return res.json(
      successResponse(
        { items: result.items },
        'Типы цен для заказов клиентов',
        pagedMeta(result.total, result.items.length, result.limit, result.offset)
      )
    );
  } catch (err) {
    return handleError(res, err, 'Ошибка получения типов цен для заказов клиентов');
  }
});

router.get('/products', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrdersProductsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrdersProducts(parsed.data);
    return res.json(
      successResponse(
        { items: result.items },
        'Номенклатура для заказа клиента',
        pagedMeta(result.total, result.items.length, result.limit, result.offset)
      )
    );
  } catch (err) {
    return handleError(res, err, 'Ошибка получения номенклатуры для заказа клиента');
  }
});

router.post('/products/batch', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrdersBatchProductsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const items = await getClientOrdersProductsByGuids(parsed.data);
    return res.json(successResponse({ items }, 'Данные номенклатуры для заказа клиента'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения данных номенклатуры для заказа клиента');
  }
});

router.get('/product-images/status', authorizePermissions(['manage_client_orders']), async (_req: AuthRequest, res) => {
  try {
    const result = await getClientOrderProductImagesStatus();
    return res.json(successResponse(result, 'Статус синхронизации фотографий номенклатуры'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения статуса фотографий номенклатуры');
  }
});

router.post('/product-images/sync', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrderProductImagesSyncSchema.safeParse({ ...req.query, ...req.body });
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await syncClientOrderProductImages(parsed.data);
    return res.json(successResponse(result, 'Синхронизация фотографий номенклатуры выполнена'));
  } catch (err) {
    return handleError(res, err, 'Ошибка синхронизации фотографий номенклатуры');
  }
});

router.post('/product-images/sync/:productGuid', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const productGuid = (req.params as { productGuid?: string }).productGuid;
  const parsed = clientOrderProductImagesSyncSchema.safeParse({ ...req.query, ...req.body, productGuid });
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await syncClientOrderProductImages(parsed.data);
    return res.json(successResponse(result, 'Синхронизация фотографий номенклатуры выполнена'));
  } catch (err) {
    return handleError(res, err, 'Ошибка синхронизации фотографий номенклатуры');
  }
});

router.post('/product-images/cleanup', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrderProductImagesCleanupSchema.safeParse({ ...req.query, ...req.body });
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await cleanupClientOrderProductImages(parsed.data.retentionDays);
    return res.json(successResponse(result, 'Очистка старых фотографий номенклатуры выполнена'));
  } catch (err) {
    return handleError(res, err, 'Ошибка очистки старых фотографий номенклатуры');
  }
});

router.get('/:guid', authorizePermissions(['view_client_orders']), async (req: AuthRequest, res) => {
  const parsed = orderGuidParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientOrderByGuid(parsed.data.guid, req.user!.userId);
    return res.json(successResponse(result, 'Карточка заказа клиента'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения карточки заказа клиента');
  }
});

router.post('/', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const parsed = clientOrderCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(validationMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await createClientOrder(req.user!.userId, parsed.data);
    return res.status(201).json(successResponse(result, 'Черновик заказа клиента создан'));
  } catch (err) {
    return handleError(res, err, 'Ошибка создания заказа клиента');
  }
});

router.patch('/:guid', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const params = orderGuidParamsSchema.safeParse(req.params);
  const body = clientOrderUpdateSchema.safeParse(req.body);
  if (!params.success) {
    return res.status(400).json(errorResponse(validationMessage(params.error), ErrorCodes.VALIDATION_ERROR));
  }
  if (!body.success) {
    return res.status(400).json(errorResponse(validationMessage(body.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await updateClientOrder(params.data.guid, req.user!.userId, body.data);
    return res.json(successResponse(result, 'Заказ клиента обновлен'));
  } catch (err) {
    return handleError(res, err, 'Ошибка обновления заказа клиента');
  }
});

router.delete('/:guid', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const params = orderGuidParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json(errorResponse(validationMessage(params.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await deleteDraftClientOrder(params.data.guid);
    return res.json(successResponse(result, 'Черновик заказа клиента удален'));
  } catch (err) {
    return handleError(res, err, 'Ошибка удаления черновика заказа клиента');
  }
});

router.post('/:guid/submit', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const params = orderGuidParamsSchema.safeParse(req.params);
  const body = clientOrderSubmitSchema.safeParse(req.body);
  if (!params.success) {
    return res.status(400).json(errorResponse(validationMessage(params.error), ErrorCodes.VALIDATION_ERROR));
  }
  if (!body.success) {
    return res.status(400).json(errorResponse(validationMessage(body.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await submitClientOrder(params.data.guid, req.user!.userId, body.data);
    return res.json(successResponse(result, 'Заказ клиента отправлен в 1С'));
  } catch (err) {
    return handleError(res, err, 'Ошибка отправки заказа клиента в 1С');
  }
});

router.post('/:guid/unqueue', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const params = orderGuidParamsSchema.safeParse(req.params);
  const body = clientOrderUnqueueSchema.safeParse(req.body);
  if (!params.success) {
    return res.status(400).json(errorResponse(validationMessage(params.error), ErrorCodes.VALIDATION_ERROR));
  }
  if (!body.success) {
    return res.status(400).json(errorResponse(validationMessage(body.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await unqueueClientOrder(params.data.guid, req.user!.userId, body.data);
    return res.json(successResponse(result, 'Заказ клиента снят с очереди'));
  } catch (err) {
    return handleError(res, err, 'Ошибка снятия заказа клиента с очереди');
  }
});

router.post('/:guid/copy', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const params = orderGuidParamsSchema.safeParse(req.params);
  const body = clientOrderCopySchema.safeParse(req.body);
  if (!params.success) {
    return res.status(400).json(errorResponse(validationMessage(params.error), ErrorCodes.VALIDATION_ERROR));
  }
  if (!body.success) {
    return res.status(400).json(errorResponse(validationMessage(body.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await copyClientOrder(params.data.guid, req.user!.userId, body.data);
    return res.status(201).json(successResponse(result, 'Копия заказа клиента создана'));
  } catch (err) {
    return handleError(res, err, 'Ошибка копирования заказа клиента');
  }
});

router.post('/:guid/restore', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const params = orderGuidParamsSchema.safeParse(req.params);
  const body = clientOrderRestoreSchema.safeParse(req.body);
  if (!params.success) {
    return res.status(400).json(errorResponse(validationMessage(params.error), ErrorCodes.VALIDATION_ERROR));
  }
  if (!body.success) {
    return res.status(400).json(errorResponse(validationMessage(body.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await restoreClientOrder(params.data.guid, req.user!.userId, body.data);
    return res.json(successResponse(result, 'Заказ клиента восстановлен'));
  } catch (err) {
    return handleError(res, err, 'Ошибка восстановления заказа клиента');
  }
});

router.post('/:guid/cancel', authorizePermissions(['manage_client_orders']), async (req: AuthRequest, res) => {
  const params = orderGuidParamsSchema.safeParse(req.params);
  const body = clientOrderCancelSchema.safeParse(req.body);
  if (!params.success) {
    return res.status(400).json(errorResponse(validationMessage(params.error), ErrorCodes.VALIDATION_ERROR));
  }
  if (!body.success) {
    return res.status(400).json(errorResponse(validationMessage(body.error), ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await cancelClientOrder(params.data.guid, req.user!.userId, body.data);
    return res.json(successResponse(result, 'Заказ клиента отменен'));
  } catch (err) {
    return handleError(res, err, 'Ошибка отмены заказа клиента');
  }
});

export default router;
