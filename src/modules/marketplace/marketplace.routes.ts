import express from 'express';
import { ZodError } from 'zod';
import { authenticateToken, AuthRequest } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import { errorResponse, ErrorCodes, successResponse } from '../../utils/apiResponse';
import {
  includeInactiveQuerySchema,
  listProductsQuerySchema,
  meContextUpdateSchema,
  orderCreateSchema,
  orderGuidParamsSchema,
  productGuidParamsSchema,
  ordersListQuerySchema,
  resolvePriceQuerySchema,
  stockQuerySchema,
} from './marketplace.schemas';
import {
  createOrder,
  getClientContext,
  getClientCounterparty,
  getOrderByGuid,
  getProductByGuid,
  getProductStock,
  listClientAgreements,
  listOrders,
  listProducts,
  listWarehouses,
  MarketplaceError,
  resolveEffectivePrice,
  updateClientContext,
} from './marketplace.service';

const router = express.Router();

router.use(authenticateToken, checkUserStatus);

const handleError = (res: express.Response, err: unknown, fallbackMessage: string) => {
  if (err instanceof MarketplaceError) {
    return res.status(err.status).json(errorResponse(err.message, err.code));
  }
  if (err instanceof ZodError) {
    return res.status(400).json(errorResponse(err.message, ErrorCodes.VALIDATION_ERROR));
  }
  console.error(fallbackMessage, err);
  return res.status(500).json(errorResponse(fallbackMessage, ErrorCodes.INTERNAL_ERROR));
};

/**
 * @openapi
 * /api/marketplace/me/context:
 *   get:
 *     tags: [Marketplace]
 *     summary: Получить текущий B2B-контекст клиента
 *     security: [ { bearerAuth: [] } ]
 *     responses:
 *       200:
 *         description: Контекст клиента
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Контекст клиента
 *               data:
 *                 profile:
 *                   userId: 1
 *                   phone: "79990000000"
 *                 context:
 *                   counterparty:
 *                     guid: COUNTERPARTY_GUID
 *                     name: ООО Ресторан
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/me/context', async (req: AuthRequest, res) => {
  try {
    const result = await getClientContext(req.user!.userId);
    return res.json(successResponse(result, 'Контекст клиента'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения контекста клиента');
  }
});

/**
 * @openapi
 * /api/marketplace/me/context:
 *   put:
 *     tags: [Marketplace]
 *     summary: Обновить B2B-контекст клиента
 *     security: [ { bearerAuth: [] } ]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               counterpartyGuid: { type: string, nullable: true }
 *               activeAgreementGuid: { type: string, nullable: true }
 *               activeContractGuid: { type: string, nullable: true }
 *               activeWarehouseGuid: { type: string, nullable: true }
 *               activePriceTypeGuid: { type: string, nullable: true }
 *               activeDeliveryAddressGuid: { type: string, nullable: true }
 *           example:
 *             counterpartyGuid: COUNTERPARTY_GUID
 *             activeAgreementGuid: AGREEMENT_GUID
 *             activeWarehouseGuid: WAREHOUSE_GUID
 *     responses:
 *       200:
 *         description: Контекст обновлён
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации или несогласованные GUID
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.put('/me/context', async (req: AuthRequest, res) => {
  const parsed = meContextUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await updateClientContext(req.user!.userId, parsed.data);
    return res.json(successResponse(result, 'Контекст клиента обновлён'));
  } catch (err) {
    return handleError(res, err, 'Ошибка обновления контекста клиента');
  }
});

/**
 * @openapi
 * /api/marketplace/me/counterparty:
 *   get:
 *     tags: [Marketplace]
 *     summary: Получить контрагента клиента и его данные
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - in: query
 *         name: includeInactive
 *         required: false
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Контрагент клиента
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Контрагент не выбран
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/me/counterparty', async (req: AuthRequest, res) => {
  const parsed = includeInactiveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await getClientCounterparty(req.user!.userId, parsed.data);
    return res.json(successResponse(result, 'Контрагент клиента'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения контрагента');
  }
});

/**
 * @openapi
 * /api/marketplace/me/agreements:
 *   get:
 *     tags: [Marketplace]
 *     summary: Получить соглашения текущего контрагента
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - in: query
 *         name: includeInactive
 *         required: false
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Список соглашений
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Соглашения клиента
 *               data:
 *                 - guid: AGREEMENT_GUID
 *                   name: Соглашение интернет-заказы
 *                   isActive: true
 *               meta:
 *                 total: 1
 *       400:
 *         description: Контрагент не выбран
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/me/agreements', async (req: AuthRequest, res) => {
  const parsed = includeInactiveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await listClientAgreements(req.user!.userId, parsed.data);
    return res.json(successResponse(result.items, 'Соглашения клиента', { total: result.total }));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения соглашений');
  }
});

/**
 * @openapi
 * /api/marketplace/warehouses:
 *   get:
 *     tags: [Marketplace]
 *     summary: Получить список складов
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - in: query
 *         name: includeInactive
 *         required: false
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Список складов
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Склады
 *               data:
 *                 - guid: WAREHOUSE_GUID
 *                   name: Основной склад
 *                   isActive: true
 *               meta:
 *                 total: 1
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/warehouses', async (req: AuthRequest, res) => {
  const parsed = includeInactiveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await listWarehouses(parsed.data);
    return res.json(successResponse(result.items, 'Склады', { total: result.total }));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения складов');
  }
});

/**
 * @openapi
 * /api/marketplace/products:
 *   get:
 *     tags: [Marketplace]
 *     summary: Каталог товаров
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - in: query
 *         name: search
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: groupGuid
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *       - in: query
 *         name: offset
 *         required: false
 *         schema: { type: integer, minimum: 0, default: 0 }
 *       - in: query
 *         name: includeInactive
 *         required: false
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Каталог товаров
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Каталог товаров
 *               data:
 *                 - guid: PRODUCT_GUID
 *                   name: Лосось охлаждённый
 *                   isActive: true
 *               meta:
 *                 total: 1
 *                 limit: 50
 *                 offset: 0
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/products', async (req: AuthRequest<{}, any, any, any>, res) => {
  const parsed = listProductsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await listProducts(parsed.data);
    return res.json(
      successResponse(result.items, 'Каталог товаров', {
        total: result.total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      })
    );
  } catch (err) {
    return handleError(res, err, 'Ошибка получения каталога');
  }
});

/**
 * @openapi
 * /api/marketplace/products/{guid}:
 *   get:
 *     tags: [Marketplace]
 *     summary: Карточка товара
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - in: path
 *         name: guid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: includeInactiveWarehouses
 *         required: false
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Карточка товара
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       404:
 *         description: Товар не найден
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/products/:guid', async (req: AuthRequest<{ guid: string }>, res) => {
  const paramsParsed = productGuidParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json(errorResponse(paramsParsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  const queryParsed = stockQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    return res.status(400).json(errorResponse(queryParsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const product = await getProductByGuid(paramsParsed.data.guid, queryParsed.data.includeInactiveWarehouses);
    return res.json(successResponse(product, 'Карточка товара'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения товара');
  }
});

/**
 * @openapi
 * /api/marketplace/products/{guid}/stock:
 *   get:
 *     tags: [Marketplace]
 *     summary: Остатки товара по складам
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - in: path
 *         name: guid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: warehouseGuid
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: includeInactiveWarehouses
 *         required: false
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: Остатки по товару
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       404:
 *         description: Товар или склад не найдены
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/products/:guid/stock', async (req: AuthRequest<{ guid: string }>, res) => {
  const paramsParsed = productGuidParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json(errorResponse(paramsParsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  const queryParsed = stockQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    return res.status(400).json(errorResponse(queryParsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const stock = await getProductStock(
      paramsParsed.data.guid,
      queryParsed.data.warehouseGuid,
      queryParsed.data.includeInactiveWarehouses
    );
    return res.json(successResponse(stock, 'Остатки по товару'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения остатков');
  }
});

/**
 * @openapi
 * /api/marketplace/prices/resolve:
 *   get:
 *     tags: [Marketplace]
 *     summary: Рассчитать эффективную цену
 *     description: Возвращает цену с учётом соглашений, контрагента, типа цен и спеццен.
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - in: query
 *         name: productGuid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: counterpartyGuid
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: agreementGuid
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: priceTypeGuid
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: at
 *         required: false
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Эффективная цена
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Эффективная цена
 *               data:
 *                 product:
 *                   guid: PRODUCT_GUID
 *                   name: Лосось охлаждённый
 *                 match:
 *                   source: SPECIAL_PRICE
 *                   level: AGREEMENT
 *                 price:
 *                   value: 100.5
 *                   currency: RUB
 *       400:
 *         description: Ошибка валидации или несогласованные GUID
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       404:
 *         description: Товар или цена не найдены
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/prices/resolve', async (req: AuthRequest<{}, any, any, any>, res) => {
  const parsed = resolvePriceQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const resolved = await resolveEffectivePrice(parsed.data);
    return res.json(successResponse(resolved, 'Эффективная цена'));
  } catch (err) {
    return handleError(res, err, 'Ошибка расчёта цены');
  }
});

/**
 * @openapi
 * /api/marketplace/orders:
 *   post:
 *     tags: [Marketplace]
 *     summary: Создать заказ клиента
 *     security: [ { bearerAuth: [] } ]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items]
 *             properties:
 *               agreementGuid: { type: string, nullable: true }
 *               contractGuid: { type: string, nullable: true }
 *               warehouseGuid: { type: string, nullable: true }
 *               deliveryAddressGuid: { type: string, nullable: true }
 *               priceTypeGuid: { type: string, nullable: true }
 *               deliveryDate: { type: string, format: date-time, nullable: true }
 *               comment: { type: string, nullable: true }
 *               currency: { type: string, nullable: true }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [productGuid, quantity]
 *                   properties:
 *                     productGuid: { type: string }
 *                     packageGuid: { type: string, nullable: true }
 *                     unitGuid: { type: string, nullable: true }
 *                     quantity: { type: number }
 *           example:
 *             agreementGuid: AGREEMENT_GUID
 *             warehouseGuid: WAREHOUSE_GUID
 *             comment: Доставка до 18:00
 *             items:
 *               - productGuid: PRODUCT_GUID
 *                 quantity: 2
 *     responses:
 *       200:
 *         description: Заказ создан
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации или бизнес-правил
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.post('/orders', async (req: AuthRequest, res) => {
  const parsed = orderCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const order = await createOrder(req.user!.userId, parsed.data);
    return res.json(successResponse(order, 'Заказ создан'));
  } catch (err) {
    return handleError(res, err, 'Ошибка создания заказа');
  }
});

/**
 * @openapi
 * /api/marketplace/orders:
 *   get:
 *     tags: [Marketplace]
 *     summary: Получить список заказов клиента
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - in: query
 *         name: status
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: offset
 *         required: false
 *         schema: { type: integer, minimum: 0, default: 0 }
 *     responses:
 *       200:
 *         description: Список заказов
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Заказы клиента
 *               data:
 *                 - guid: ORDER_GUID
 *                   status: QUEUED
 *                   totalAmount: 1500.25
 *                   currency: RUB
 *               meta:
 *                 total: 1
 *                 limit: 20
 *                 offset: 0
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/orders', async (req: AuthRequest, res) => {
  const parsed = ordersListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(errorResponse(parsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const result = await listOrders(req.user!.userId, parsed.data);
    return res.json(
      successResponse(result.items, 'Заказы клиента', {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      })
    );
  } catch (err) {
    return handleError(res, err, 'Ошибка получения заказов');
  }
});

/**
 * @openapi
 * /api/marketplace/orders/{guid}:
 *   get:
 *     tags: [Marketplace]
 *     summary: Получить заказ по guid
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - in: path
 *         name: guid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Заказ
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       404:
 *         description: Заказ не найден
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/orders/:guid', async (req: AuthRequest<{ guid: string }>, res) => {
  const paramsParsed = orderGuidParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json(errorResponse(paramsParsed.error.message, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    const order = await getOrderByGuid(req.user!.userId, paramsParsed.data.guid);
    return res.json(successResponse(order, 'Заказ'));
  } catch (err) {
    return handleError(res, err, 'Ошибка получения заказа');
  }
});

export default router;
