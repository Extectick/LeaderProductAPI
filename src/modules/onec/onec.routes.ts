import { Router } from 'express';
import {
  handleAgreementsBatch,
  handleCounterpartiesBatch,
  handleNomenclatureBatch,
  handleOrderAck,
  handleOrdersQueued,
  handleOrdersStatusBatch,
  handleProductPricesBatch,
  handleSpecialPricesBatch,
  handleSyncRunDetail,
  handleSyncRunsList,
  handleStockBatch,
  handleWarehousesBatch,
  onecAuthMiddleware,
} from './onec.controllers';

const router = Router();

router.use(onecAuthMiddleware);

/**
 * @openapi
 * /api/1c/nomenclature/batch:
 *   post:
 *     tags: [1C]
 *     summary: Импорт номенклатуры (группы и товары)
 *     description: Принимает батч номенклатуры из 1С и выполняет upsert по guid.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [secret, items]
 *             properties:
 *               secret:
 *                 type: string
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [guid, isGroup, name]
 *                   properties:
 *                     guid: { type: string }
 *                     isGroup: { type: boolean }
 *                     parentGuid: { type: string, nullable: true }
 *                     name: { type: string }
 *                     code: { type: string, nullable: true }
 *                     article: { type: string, nullable: true }
 *                     sku: { type: string, nullable: true }
 *                     isWeight: { type: boolean, nullable: true }
 *                     isService: { type: boolean, nullable: true }
 *                     isActive: { type: boolean, nullable: true }
 *           example:
 *             secret: ONEC_SECRET_VALUE
 *             items:
 *               - guid: GUID_GROUP
 *                 isGroup: true
 *                 parentGuid: null
 *                 name: Морепродукты
 *               - guid: GUID_PRODUCT
 *                 isGroup: false
 *                 parentGuid: GUID_GROUP
 *                 name: Лосось охлаждённый
 *                 code: 0002
 *                 isActive: true
 *     responses:
 *       200:
 *         description: Батч успешно обработан
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.post('/nomenclature/batch', handleNomenclatureBatch);

/**
 * @openapi
 * /api/1c/stock/batch:
 *   post:
 *     tags: [1C]
 *     summary: Импорт остатков по складам
 *     description: Обновляет остатки по паре productGuid + warehouseGuid.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [secret, items]
 *             properties:
 *               secret: { type: string }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [productGuid, warehouseGuid, quantity, updatedAt]
 *                   properties:
 *                     productGuid: { type: string }
 *                     warehouseGuid: { type: string }
 *                     quantity: { type: number }
 *                     reserved: { type: number, nullable: true }
 *                     updatedAt: { type: string, format: date-time }
 *           example:
 *             secret: ONEC_SECRET_VALUE
 *             items:
 *               - productGuid: GUID_PRODUCT
 *                 warehouseGuid: GUID_WAREHOUSE
 *                 quantity: 123.456
 *                 reserved: 10
 *                 updatedAt: 2025-12-11T10:00:00Z
 *     responses:
 *       200:
 *         description: Батч успешно обработан
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.post('/stock/batch', handleStockBatch);

/**
 * @openapi
 * /api/1c/counterparties/batch:
 *   post:
 *     tags: [1C]
 *     summary: Импорт контрагентов и адресов доставки
 *     description: Выполняет upsert контрагентов и их адресов по guid.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [secret, items]
 *             properties:
 *               secret: { type: string }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [guid, name]
 *                   properties:
 *                     guid: { type: string }
 *                     name: { type: string }
 *                     fullName: { type: string, nullable: true }
 *                     inn: { type: string, nullable: true }
 *                     kpp: { type: string, nullable: true }
 *                     phone: { type: string, nullable: true }
 *                     email: { type: string, nullable: true }
 *                     isActive: { type: boolean, nullable: true }
 *                     addresses:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           guid: { type: string, nullable: true }
 *                           name: { type: string, nullable: true }
 *                           fullAddress: { type: string }
 *                           isDefault: { type: boolean, nullable: true }
 *                           isActive: { type: boolean, nullable: true }
 *           example:
 *             secret: ONEC_SECRET_VALUE
 *             items:
 *               - guid: GUID_COUNTERPARTY
 *                 name: ООО Ресторан
 *                 inn: "5500000000"
 *                 isActive: true
 *                 addresses:
 *                   - guid: GUID_ADDRESS
 *                     fullAddress: г. Омск, ул. Ленина, д.1
 *                     isDefault: true
 *                     isActive: true
 *     responses:
 *       200:
 *         description: Батч успешно обработан
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.post('/counterparties/batch', handleCounterpartiesBatch);

/**
 * @openapi
 * /api/1c/warehouses/batch:
 *   post:
 *     tags: [1C]
 *     summary: Импорт складов
 *     description: Выполняет upsert складов по guid.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [secret, items]
 *             properties:
 *               secret: { type: string }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [guid, name]
 *                   properties:
 *                     guid: { type: string }
 *                     name: { type: string }
 *                     code: { type: string, nullable: true }
 *                     address: { type: string, nullable: true }
 *                     isActive: { type: boolean, nullable: true }
 *                     isDefault: { type: boolean, nullable: true }
 *                     isPickup: { type: boolean, nullable: true }
 *           example:
 *             secret: ONEC_SECRET_VALUE
 *             items:
 *               - guid: GUID_WAREHOUSE
 *                 name: Основной склад
 *                 code: "00001"
 *                 isActive: true
 *                 isDefault: true
 *     responses:
 *       200:
 *         description: Батч успешно обработан
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.post('/warehouses/batch', handleWarehousesBatch);

/**
 * @openapi
 * /api/1c/agreements/batch:
 *   post:
 *     tags: [1C]
 *     summary: Импорт договоров, соглашений и типов цен
 *     description: Обновляет типы цен, договоры и соглашения по guid с привязками.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [secret, items]
 *             properties:
 *               secret: { type: string }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   properties:
 *                     priceType:
 *                       type: object
 *                       properties:
 *                         guid: { type: string }
 *                         name: { type: string }
 *                         code: { type: string, nullable: true }
 *                         isActive: { type: boolean, nullable: true }
 *                     contract:
 *                       type: object
 *                       properties:
 *                         guid: { type: string }
 *                         counterpartyGuid: { type: string }
 *                         number: { type: string }
 *                         date: { type: string, format: date-time }
 *                         isActive: { type: boolean, nullable: true }
 *                     agreement:
 *                       type: object
 *                       properties:
 *                         guid: { type: string }
 *                         name: { type: string }
 *                         counterpartyGuid: { type: string, nullable: true }
 *                         contractGuid: { type: string, nullable: true }
 *                         priceTypeGuid: { type: string, nullable: true }
 *                         warehouseGuid: { type: string, nullable: true }
 *                         currency: { type: string, nullable: true }
 *                         isActive: { type: boolean, nullable: true }
 *           example:
 *             secret: ONEC_SECRET_VALUE
 *             items:
 *               - priceType:
 *                   guid: GUID_PRICE_TYPE
 *                   name: Оптовая
 *                   isActive: true
 *                 contract:
 *                   guid: GUID_CONTRACT
 *                   counterpartyGuid: GUID_COUNTERPARTY
 *                   number: Д-001
 *                   date: 2025-01-01T00:00:00Z
 *                 agreement:
 *                   guid: GUID_AGREEMENT
 *                   name: Соглашение интернет-заказы
 *                   counterpartyGuid: GUID_COUNTERPARTY
 *                   contractGuid: GUID_CONTRACT
 *                   priceTypeGuid: GUID_PRICE_TYPE
 *                   warehouseGuid: GUID_WAREHOUSE
 *                   currency: RUB
 *                   isActive: true
 *     responses:
 *       200:
 *         description: Батч успешно обработан
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.post('/agreements/batch', handleAgreementsBatch);

/**
 * @openapi
 * /api/1c/product-prices/batch:
 *   post:
 *     tags: [1C]
 *     summary: Импорт базовых цен номенклатуры
 *     description: Загружает базовые цены (ProductPrice) по guid или композитному ключу.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [secret, items]
 *             properties:
 *               secret: { type: string }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [productGuid, price]
 *                   properties:
 *                     guid: { type: string, nullable: true }
 *                     productGuid: { type: string }
 *                     priceTypeGuid: { type: string, nullable: true }
 *                     price: { type: number }
 *                     currency: { type: string, nullable: true }
 *                     startDate: { type: string, format: date-time, nullable: true }
 *                     endDate: { type: string, format: date-time, nullable: true }
 *                     minQty: { type: number, nullable: true }
 *                     isActive: { type: boolean, nullable: true }
 *           example:
 *             secret: ONEC_SECRET_VALUE
 *             items:
 *               - guid: GUID_PRICE
 *                 productGuid: GUID_PRODUCT
 *                 priceTypeGuid: GUID_PRICE_TYPE
 *                 price: 120.5
 *                 currency: RUB
 *                 startDate: 2025-01-01T00:00:00Z
 *                 isActive: true
 *     responses:
 *       200:
 *         description: Батч успешно обработан
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.post('/product-prices/batch', handleProductPricesBatch);

/**
 * @openapi
 * /api/1c/special-prices/batch:
 *   post:
 *     tags: [1C]
 *     summary: Импорт спеццен
 *     description: Загружает спеццены с приоритетами по соглашению, контрагенту и типу цен.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [secret, items]
 *             properties:
 *               secret: { type: string }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [productGuid, price]
 *                   properties:
 *                     guid: { type: string, nullable: true }
 *                     productGuid: { type: string }
 *                     counterpartyGuid: { type: string, nullable: true }
 *                     agreementGuid: { type: string, nullable: true }
 *                     priceTypeGuid: { type: string, nullable: true }
 *                     price: { type: number }
 *                     currency: { type: string, nullable: true }
 *                     startDate: { type: string, format: date-time, nullable: true }
 *                     endDate: { type: string, format: date-time, nullable: true }
 *                     minQty: { type: number, nullable: true }
 *                     isActive: { type: boolean, nullable: true }
 *           example:
 *             secret: ONEC_SECRET_VALUE
 *             items:
 *               - guid: GUID_SPECIAL_PRICE
 *                 productGuid: GUID_PRODUCT
 *                 counterpartyGuid: GUID_COUNTERPARTY
 *                 price: 100.5
 *                 currency: RUB
 *                 startDate: 2025-01-01T00:00:00Z
 *                 minQty: 10
 *                 isActive: true
 *     responses:
 *       200:
 *         description: Батч успешно обработан
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.post('/special-prices/batch', handleSpecialPricesBatch);

/**
 * @openapi
 * /api/1c/orders/queued:
 *   get:
 *     tags: [1C]
 *     summary: Получить очередь заказов на выгрузку в 1С
 *     description: Возвращает заказы в статусе QUEUED (и SENT_TO_1C при includeSent=true).
 *     parameters:
 *       - in: query
 *         name: secret
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: includeSent
 *         required: false
 *         schema: { type: boolean }
 *         description: Включать заказы в статусе SENT_TO_1C
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *     responses:
 *       200:
 *         description: Очередь заказов
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 count: { type: integer }
 *                 orders:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       guid: { type: string }
 *                       status: { type: string }
 *                       items:
 *                         type: array
 *                         items: { type: object }
 *             example:
 *               success: true
 *               count: 1
 *               orders:
 *                 - guid: ORDER_GUID
 *                   status: QUEUED
 *                   items: []
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/orders/queued', handleOrdersQueued);

/**
 * @openapi
 * /api/1c/orders/{guid}/ack:
 *   post:
 *     tags: [1C]
 *     summary: Подтверждение приёма заказа 1С
 *     description: 1С подтверждает приём заказа, присваивает номер/дату и фиксирует статус.
 *     parameters:
 *       - in: path
 *         name: guid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [secret]
 *             properties:
 *               secret: { type: string }
 *               status: { type: string }
 *               number1c: { type: string, nullable: true }
 *               date1c: { type: string, format: date-time, nullable: true }
 *               sentTo1cAt: { type: string, format: date-time, nullable: true }
 *               error: { type: string, nullable: true }
 *           example:
 *             secret: ONEC_SECRET_VALUE
 *             status: SENT_TO_1C
 *             number1c: "000123"
 *             date1c: 2025-01-10T00:00:00Z
 *             sentTo1cAt: 2025-01-10T00:00:05Z
 *             error: ""
 *     responses:
 *       200:
 *         description: Подтверждение принято
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.post('/orders/:guid/ack', handleOrderAck);

/**
 * @openapi
 * /api/1c/orders/status/batch:
 *   post:
 *     tags: [1C]
 *     summary: Импорт статусов заказов из 1С
 *     description: Обновляет статусы, номер/дату 1С и итоговые суммы заказов.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [secret, items]
 *             properties:
 *               secret: { type: string }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [guid, status]
 *                   properties:
 *                     guid: { type: string }
 *                     status: { type: string }
 *                     number1c: { type: string, nullable: true }
 *                     date1c: { type: string, format: date-time, nullable: true }
 *                     comment: { type: string, nullable: true }
 *                     totalAmount: { type: number, nullable: true }
 *                     currency: { type: string, nullable: true }
 *           example:
 *             secret: ONEC_SECRET_VALUE
 *             items:
 *               - guid: ORDER_GUID
 *                 status: CONFIRMED
 *                 number1c: "000123"
 *                 date1c: 2025-01-10T00:00:00Z
 *                 totalAmount: 1500.25
 *                 currency: RUB
 *     responses:
 *       200:
 *         description: Батч успешно обработан
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.post('/orders/status/batch', handleOrdersStatusBatch);

/**
 * @openapi
 * /api/1c/sync/runs:
 *   get:
 *     tags: [1C]
 *     summary: Список запусков синхронизации
 *     description: Возвращает журнал синхронизаций с фильтрами по entity/direction/status.
 *     parameters:
 *       - in: query
 *         name: secret
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: entity
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: direction
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         required: false
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *     responses:
 *       200:
 *         description: Список запусков синхронизации
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 count: { type: integer }
 *                 runs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       entity: { type: string }
 *                       direction: { type: string }
 *                       status: { type: string }
 *             example:
 *               success: true
 *               count: 1
 *               runs:
 *                 - id: SYNC_RUN_ID
 *                   entity: NOMENCLATURE
 *                   direction: IMPORT
 *                   status: COMPLETED
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/sync/runs', handleSyncRunsList);

/**
 * @openapi
 * /api/1c/sync/runs/{runId}:
 *   get:
 *     tags: [1C]
 *     summary: Детали запуска синхронизации
 *     description: Возвращает информацию по конкретному запуску синхронизации и опционально items.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: secret
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: includeItems
 *         required: false
 *         schema: { type: boolean }
 *       - in: query
 *         name: itemsLimit
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 200 }
 *     responses:
 *       200:
 *         description: Детали запуска синхронизации
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 run:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     entity: { type: string }
 *                     direction: { type: string }
 *                     status: { type: string }
 *             example:
 *               success: true
 *               run:
 *                 id: SYNC_RUN_ID
 *                 entity: STOCK
 *                 direction: IMPORT
 *                 status: PARTIAL
 *       401:
 *         description: Неверный secret
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 */
router.get('/sync/runs/:runId', handleSyncRunDetail);

export default router;
