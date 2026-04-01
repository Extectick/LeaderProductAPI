"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const client_1 = require("@prisma/client");
const client_2 = __importDefault(require("../prisma/client"));
const auth_1 = require("../middleware/auth");
const checkUserStatus_1 = require("../middleware/checkUserStatus");
const audit_1 = require("../middleware/audit");
const apiResponse_1 = require("../utils/apiResponse");
const userService_1 = require("../services/userService");
const pushService_1 = require("../services/pushService");
const profileModerationNotificationService_1 = require("../services/profileModerationNotificationService");
const presenceService_1 = require("../services/presenceService");
const minio_1 = require("../storage/minio");
const phone_1 = require("../utils/phone");
const phoneVerificationService_1 = require("../services/phoneVerificationService");
const emailChangeService_1 = require("../services/emailChangeService");
const permissionCatalog_1 = require("../rbac/permissionCatalog");
const router = express_1.default.Router();
const USER_LIST_SELECT = {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    phone: true,
    avatarUrl: true,
    lastSeenAt: true,
    profileStatus: true,
    currentProfileType: true,
    role: { select: { id: true, name: true, displayName: true } },
    clientProfile: { select: { avatarUrl: true } },
    supplierProfile: { select: { avatarUrl: true } },
    employeeProfile: { select: { departmentId: true, avatarUrl: true, department: { select: { id: true, name: true } } } },
};
const ADMIN_USER_LIST_SELECT = {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    middleName: true,
    phone: true,
    avatarUrl: true,
    lastSeenAt: true,
    createdAt: true,
    profileStatus: true,
    currentProfileType: true,
    telegramId: true,
    maxId: true,
    role: { select: { id: true, name: true, displayName: true } },
    clientProfile: { select: { avatarUrl: true } },
    supplierProfile: { select: { avatarUrl: true } },
    employeeProfile: {
        select: {
            status: true,
            departmentId: true,
            avatarUrl: true,
            department: { select: { id: true, name: true } },
        },
    },
    _count: {
        select: {
            deviceTokens: true,
        },
    },
};
const SYSTEM_ROLE_NAME_SET = new Set(permissionCatalog_1.SYSTEM_ROLE_NAMES);
const ADMIN_LIST_SORT_FIELDS = new Set(['createdAt', 'name', 'email', 'lastSeenAt', 'role', 'status']);
const ADMIN_LIST_SORT_DIRS = new Set(['asc', 'desc']);
const ADMIN_MODERATION_STATE_SET = new Set([
    'NO_EMPLOYEE_PROFILE',
    'EMPLOYEE_PENDING',
    'EMPLOYEE_ACTIVE',
    'EMPLOYEE_BLOCKED',
]);
function resolveRoleDisplayName(name, displayName) {
    const explicit = String(displayName || '').trim();
    if (explicit)
        return explicit;
    return permissionCatalog_1.DEFAULT_ROLE_DISPLAY_NAMES[name] || name;
}
function resolveEmployeeModerationState(status) {
    if (!status)
        return 'NO_EMPLOYEE_PROFILE';
    if (status === 'ACTIVE')
        return 'EMPLOYEE_ACTIVE';
    if (status === 'BLOCKED')
        return 'EMPLOYEE_BLOCKED';
    return 'EMPLOYEE_PENDING';
}
function resolvePermissionGroupView(input) {
    const group = input.group;
    if (group) {
        return {
            id: group.id,
            key: group.key,
            displayName: String(group.displayName || '').trim() || group.key,
            description: String(group.description || '').trim(),
            isSystem: Boolean(group.isSystem),
            sortOrder: group.sortOrder,
            serviceId: group.serviceId ?? null,
            ...(group.service ? { service: group.service } : {}),
        };
    }
    const fallbackKey = String(input.fallbackGroupKey || permissionCatalog_1.DEFAULT_PERMISSION_GROUP_KEY);
    const fromDb = input.groupsByKey?.get(fallbackKey) || input.groupsByKey?.get(permissionCatalog_1.DEFAULT_PERMISSION_GROUP_KEY);
    if (fromDb)
        return fromDb;
    const fromCatalog = permissionCatalog_1.PERMISSION_GROUP_CATALOG_BY_KEY.get(fallbackKey) ||
        permissionCatalog_1.PERMISSION_GROUP_CATALOG_BY_KEY.get(permissionCatalog_1.DEFAULT_PERMISSION_GROUP_KEY);
    if (fromCatalog) {
        return {
            id: 0,
            key: fromCatalog.key,
            displayName: fromCatalog.displayName,
            description: fromCatalog.description,
            isSystem: fromCatalog.isSystem,
            sortOrder: fromCatalog.sortOrder,
            serviceId: null,
        };
    }
    return {
        id: 0,
        key: permissionCatalog_1.DEFAULT_PERMISSION_GROUP_KEY,
        displayName: 'Основные',
        description: '',
        isSystem: true,
        sortOrder: 10,
        serviceId: null,
    };
}
async function validateParentRoleId(parentRoleId) {
    if (parentRoleId === null)
        return { valid: true };
    const parentRole = await client_2.default.role.findUnique({
        where: { id: parentRoleId },
        select: { id: true },
    });
    if (!parentRole) {
        return { valid: false, message: 'Родительская роль не найдена' };
    }
    return { valid: true };
}
async function wouldCreateRoleCycle(roleId, parentRoleId) {
    let currentRoleId = parentRoleId;
    const visited = new Set();
    while (currentRoleId) {
        if (currentRoleId === roleId)
            return true;
        if (visited.has(currentRoleId))
            return true;
        visited.add(currentRoleId);
        const parent = await client_2.default.role.findUnique({
            where: { id: currentRoleId },
            select: { parentRoleId: true },
        });
        currentRoleId = parent?.parentRoleId ?? null;
    }
    return false;
}
function toPositiveInt(raw, fallback, limits) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed))
        return fallback;
    const normalized = Math.trunc(parsed);
    const min = limits?.min ?? 1;
    const max = limits?.max ?? Number.MAX_SAFE_INTEGER;
    if (normalized < min)
        return min;
    if (normalized > max)
        return max;
    return normalized;
}
function toOptionalInt(raw) {
    if (raw === undefined || raw === null || raw === '')
        return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed))
        return null;
    const normalized = Math.trunc(parsed);
    return normalized > 0 ? normalized : null;
}
function toOnlineFilter(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value)
        return null;
    if (value === '1' || value === 'true' || value === 'online')
        return true;
    if (value === '0' || value === 'false' || value === 'offline')
        return false;
    return null;
}
function buildAdminListOrder(sortBy, sortDir) {
    if (sortBy === 'name') {
        return [{ lastName: sortDir }, { firstName: sortDir }, { id: 'asc' }];
    }
    if (sortBy === 'email') {
        return [{ email: sortDir }, { id: 'asc' }];
    }
    if (sortBy === 'createdAt') {
        return [{ createdAt: sortDir }, { id: 'asc' }];
    }
    if (sortBy === 'role') {
        return [{ role: { name: sortDir } }, { id: 'asc' }];
    }
    return [{ lastSeenAt: sortDir }, { id: 'asc' }];
}
const avatarUpload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype?.startsWith('image/'))
            return cb(null, true);
        cb(new Error('Only image uploads are allowed'));
    },
});
/**
 * @openapi
 * tags:
 *   - name: Users
 *     description: Пользователи, профили и отделы
 */
/**
 * @openapi
 * /users/me/department:
 *   put:
 *     tags: [Users]
 *     summary: Пользователь обновляет свой отдел
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               departmentId:
 *                 type: number
 *             required: [departmentId]
 *     responses:
 *       200:
 *         description: Отдел обновлён
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/MessageOnly' }
 *       400: { description: Неверные данные }
 *       401: { description: Не авторизован }
 *       404: { description: Отдел не найден }
 */
router.put('/me/department', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, audit_1.auditLog)('Пользователь обновил свой отдел'), async (req, res) => {
    try {
        const userId = req.user.userId;
        const { departmentId } = req.body;
        if (!departmentId) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('ID отдела обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const departmentIdNum = Number(departmentId);
        if (isNaN(departmentIdNum)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID отдела', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const department = await client_2.default.department.findUnique({ where: { id: departmentIdNum } });
        if (!department) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        await client_2.default.employeeProfile.updateMany({
            where: { userId: Number(userId) },
            data: { departmentId: departmentIdNum },
        });
        res.json((0, apiResponse_1.successResponse)({ message: 'Отдел пользователя обновлен' }));
    }
    catch (error) {
        if (error instanceof Error) {
            res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
        }
        else {
            res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
        }
    }
});
/**
 * @openapi
 * /users/{userId}/department:
 *   put:
 *     tags: [Users]
 *     summary: Администратор назначает отдел пользователю
 *     security:
 *       - bearerAuth: []
 *     x-roles: [admin]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               departmentId:
 *                 type: number
 *             required: [departmentId]
 *     responses:
 *       200:
 *         description: Отдел назначен
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/MessageOnly' }
 *       400: { description: Неверные параметры }
 *       401: { description: Не авторизован }
 *       403: { description: Нет прав }
 *       404: { description: Пользователь или отдел не найдены }
 */
router.put('/:userId/department', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizeRoles)(['admin']), (0, audit_1.auditLog)('Админ обновил отдел пользователя'), async (req, res) => {
    try {
        const { userId } = req.params;
        const { departmentId } = req.body;
        if (!departmentId) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('ID отдела обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const departmentIdNum = Number(departmentId);
        if (isNaN(departmentIdNum)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID отдела', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const userIdNum = Number(userId);
        if (isNaN(userIdNum)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID пользователя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const user = await client_2.default.user.findUnique({ where: { id: userIdNum } });
        if (!user) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const department = await client_2.default.department.findUnique({ where: { id: departmentIdNum } });
        if (!department) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        await client_2.default.employeeProfile.updateMany({
            where: { userId: userIdNum },
            data: { departmentId: departmentIdNum },
        });
        res.json((0, apiResponse_1.successResponse)({ message: `Отдел пользователя ${userId} обновлен` }));
    }
    catch (error) {
        if (error instanceof Error) {
            res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
        }
        else {
            res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
        }
    }
});
/**
 * @openapi
 * /users/profile:
 *   get:
 *     tags: [Users]
 *     summary: Получить профиль текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Профиль пользователя
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile:
 *                           $ref: '#/components/schemas/UserProfile'
 *       401: { description: Не авторизован }
 *       404: { description: Пользователь не найден }
 */
router.get('/profile', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user.userId;
        const profile = await (0, userService_1.getProfile)(userId);
        if (!profile) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        res.set('Cache-Control', 'no-store');
        res.json((0, apiResponse_1.successResponse)({ profile }));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения профиля', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * @openapi
 * /users/profiles/client:
 *   post:
 *     tags: [Users]
 *     summary: Создать клиентский профиль для текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user:
 *                 type: object
 *                 properties:
 *                   firstName: { type: string }
 *                   lastName: { type: string }
 *                   middleName: { type: string }
 *                 required: [firstName]
 *               address:
 *                 $ref: '#/components/schemas/Address'
 *     responses:
 *       200:
 *         description: Профиль создан
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile: { $ref: '#/components/schemas/UserProfile' }
 *                         message: { type: 'string', example: 'Профиль клиента успешно создан' }
 *       400: { description: Ошибка валидации }
 *       401: { description: Не авторизован }
 *       409: { description: Профиль уже существует }
 */
router.post('/profiles/client', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { user: userData, address, counterpartyGuid, activeAgreementGuid, activeContractGuid, activeWarehouseGuid, activePriceTypeGuid, activeDeliveryAddressGuid, } = req.body;
        if (!userData?.firstName) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Обязательное поле: user.firstName', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (address && (!address.street || !address.city || !address.country)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Если указан адрес, обязательные поля: address.street, address.city, address.country', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const existingProfile = await client_2.default.clientProfile.findUnique({ where: { userId } });
        if (existingProfile) {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Клиентский профиль уже существует', apiResponse_1.ErrorCodes.CONFLICT));
        }
        let addressId;
        if (address) {
            const createdAddress = await client_2.default.address.create({
                data: {
                    street: address.street,
                    city: address.city,
                    state: address.state,
                    postalCode: address.postalCode,
                    country: address.country
                }
            });
            addressId = createdAddress.id;
        }
        const ensureEntityActive = (entity, label) => {
            if (!entity) {
                res.status(404).json((0, apiResponse_1.errorResponse)(`${label} не найден`, apiResponse_1.ErrorCodes.NOT_FOUND));
                return null;
            }
            if (entity.isActive === false) {
                res.status(400).json((0, apiResponse_1.errorResponse)(`${label} неактивен`, apiResponse_1.ErrorCodes.VALIDATION_ERROR));
                return null;
            }
            return entity;
        };
        let counterpartyRecord = counterpartyGuid
            ? ensureEntityActive(await client_2.default.counterparty.findUnique({
                where: { guid: counterpartyGuid },
                select: { id: true, guid: true, name: true, isActive: true },
            }), 'Контрагент')
            : null;
        if (counterpartyGuid && !counterpartyRecord)
            return;
        const agreementRecord = activeAgreementGuid
            ? ensureEntityActive(await client_2.default.clientAgreement.findUnique({
                where: { guid: activeAgreementGuid },
                select: {
                    id: true,
                    guid: true,
                    name: true,
                    isActive: true,
                    counterpartyId: true,
                    contractId: true,
                    warehouseId: true,
                    priceTypeId: true,
                },
            }), 'Соглашение')
            : null;
        if (activeAgreementGuid && !agreementRecord)
            return;
        const contractRecord = activeContractGuid
            ? ensureEntityActive(await client_2.default.clientContract.findUnique({
                where: { guid: activeContractGuid },
                select: { id: true, guid: true, number: true, isActive: true, counterpartyId: true },
            }), 'Договор')
            : null;
        if (activeContractGuid && !contractRecord)
            return;
        const warehouseRecord = activeWarehouseGuid
            ? ensureEntityActive(await client_2.default.warehouse.findUnique({
                where: { guid: activeWarehouseGuid },
                select: { id: true, guid: true, name: true, isActive: true },
            }), 'Склад')
            : null;
        if (activeWarehouseGuid && !warehouseRecord)
            return;
        const priceTypeRecord = activePriceTypeGuid
            ? ensureEntityActive(await client_2.default.priceType.findUnique({
                where: { guid: activePriceTypeGuid },
                select: { id: true, guid: true, name: true, isActive: true },
            }), 'Тип цен')
            : null;
        if (activePriceTypeGuid && !priceTypeRecord)
            return;
        const deliveryAddressRecord = activeDeliveryAddressGuid
            ? ensureEntityActive(await client_2.default.deliveryAddress.findUnique({
                where: { guid: activeDeliveryAddressGuid },
                select: { id: true, guid: true, fullAddress: true, isActive: true, counterpartyId: true },
            }), 'Адрес доставки')
            : null;
        if (activeDeliveryAddressGuid && !deliveryAddressRecord)
            return;
        let resolvedCounterpartyId = counterpartyRecord?.id ?? null;
        if (agreementRecord?.counterpartyId) {
            if (resolvedCounterpartyId && resolvedCounterpartyId !== agreementRecord.counterpartyId) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)('Соглашение не принадлежит выбранному контрагенту', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            resolvedCounterpartyId = agreementRecord.counterpartyId;
        }
        if (contractRecord) {
            if (resolvedCounterpartyId && resolvedCounterpartyId !== contractRecord.counterpartyId) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)('Договор не принадлежит выбранному контрагенту', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            resolvedCounterpartyId = contractRecord.counterpartyId;
        }
        if (deliveryAddressRecord?.counterpartyId) {
            if (resolvedCounterpartyId && resolvedCounterpartyId !== deliveryAddressRecord.counterpartyId) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)('Адрес не принадлежит выбранному контрагенту', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            resolvedCounterpartyId = deliveryAddressRecord.counterpartyId;
        }
        if (agreementRecord &&
            contractRecord &&
            agreementRecord.contractId &&
            agreementRecord.contractId !== contractRecord.id) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Договор не соответствует соглашению', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (agreementRecord &&
            warehouseRecord &&
            agreementRecord.warehouseId &&
            agreementRecord.warehouseId !== warehouseRecord.id) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Склад не соответствует соглашению', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (agreementRecord &&
            priceTypeRecord &&
            agreementRecord.priceTypeId &&
            agreementRecord.priceTypeId !== priceTypeRecord.id) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Тип цен не соответствует соглашению', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (resolvedCounterpartyId && (!counterpartyRecord || counterpartyRecord.id !== resolvedCounterpartyId)) {
            counterpartyRecord = ensureEntityActive(await client_2.default.counterparty.findUnique({
                where: { id: resolvedCounterpartyId },
                select: { id: true, guid: true, name: true, isActive: true },
            }), 'Контрагент');
            if (!counterpartyRecord)
                return;
        }
        const resolvedAgreementId = agreementRecord?.id ?? null;
        const resolvedContractId = contractRecord?.id ?? agreementRecord?.contractId ?? null;
        const resolvedWarehouseId = warehouseRecord?.id ?? agreementRecord?.warehouseId ?? null;
        const resolvedPriceTypeId = priceTypeRecord?.id ?? agreementRecord?.priceTypeId ?? null;
        const resolvedDeliveryAddressId = deliveryAddressRecord?.id ?? null;
        await client_2.default.clientProfile.create({
            data: {
                userId,
                ...(addressId && { addressId }),
                counterpartyId: resolvedCounterpartyId ?? null,
                activeAgreementId: resolvedAgreementId,
                activeContractId: resolvedContractId,
                activeWarehouseId: resolvedWarehouseId,
                activePriceTypeId: resolvedPriceTypeId,
                activeDeliveryAddressId: resolvedDeliveryAddressId,
            }
        });
        await client_2.default.user.update({
            where: { id: userId },
            data: {
                firstName: userData.firstName,
                lastName: userData.lastName,
                middleName: userData.middleName,
                currentProfileType: 'CLIENT'
            }
        });
        const resProfile = await (0, userService_1.getProfile)(userId);
        res.json((0, apiResponse_1.successResponse)({
            profile: resProfile,
            message: 'Профиль клиента успешно создан'
        }));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания клиентского профиля', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * @openapi
 * /users/profiles/supplier:
 *   post:
 *     tags: [Users]
 *     summary: Создать профиль поставщика для текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user:
 *                 type: object
 *                 properties:
 *                   firstName: { type: string }
 *                   lastName: { type: string }
 *                   middleName: { type: string }
 *                 required: [firstName]
 *               address:
 *                 $ref: '#/components/schemas/Address'
 *     responses:
 *       200:
 *         description: Профиль создан
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile: { $ref: '#/components/schemas/UserProfile' }
 *                         message: { type: 'string', example: 'Профиль поставщика успешно создан' }
 *       400: { description: Ошибка валидации }
 *       401: { description: Не авторизован }
 *       409: { description: Профиль уже существует }
 */
router.post('/profiles/supplier', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { user: userData, address } = req.body;
        if (!userData?.firstName) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Обязательное поле: user.firstName', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (address && (!address.street || !address.city || !address.country)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Если указан адрес, обязательные поля: address.street, address.city, address.country', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const existingProfile = await client_2.default.supplierProfile.findUnique({ where: { userId } });
        if (existingProfile) {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Профиль поставщика уже существует', apiResponse_1.ErrorCodes.CONFLICT));
        }
        let addressId;
        if (address) {
            const createdAddress = await client_2.default.address.create({
                data: {
                    street: address.street,
                    city: address.city,
                    state: address.state,
                    postalCode: address.postalCode,
                    country: address.country
                }
            });
            addressId = createdAddress.id;
        }
        await client_2.default.supplierProfile.create({
            data: {
                userId,
                ...(addressId && { addressId })
            }
        });
        await client_2.default.user.update({
            where: { id: userId },
            data: {
                firstName: userData.firstName,
                lastName: userData.lastName,
                middleName: userData.middleName,
                currentProfileType: 'SUPPLIER'
            }
        });
        const resProfile = await (0, userService_1.getProfile)(userId);
        res.json((0, apiResponse_1.successResponse)({
            profile: resProfile,
            message: 'Профиль поставщика успешно создан'
        }));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания профиля поставщика', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * @openapi
 * /users/profiles/employee:
 *   post:
 *     tags: [Users]
 *     summary: Создать профиль сотрудника для текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user:
 *                 type: object
 *                 properties:
 *                   firstName: { type: string }
 *                   lastName: { type: string }
 *                   middleName: { type: string }
 *                 required: [firstName, lastName]
 *               departmentId: { type: number }
 *             required: [user, departmentId]
 *     responses:
 *       200:
 *         description: Профиль создан
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile: { $ref: '#/components/schemas/UserProfile' }
 *                         message: { type: 'string', example: 'Профиль сотрудника успешно создан' }
 *       400: { description: Ошибка валидации }
 *       401: { description: Не авторизован }
 *       404: { description: Отдел не найден }
 *       409: { description: Профиль уже существует }
 */
router.post('/profiles/employee', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { user: userData, departmentId } = req.body;
        if (!userData?.firstName || !userData?.lastName || !departmentId) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Обязательные поля: user.firstName, user.lastName и departmentId', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const existingProfile = await client_2.default.employeeProfile.findUnique({ where: { userId } });
        if (existingProfile) {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Профиль сотрудника уже существует', apiResponse_1.ErrorCodes.CONFLICT));
        }
        const department = await client_2.default.department.findUnique({ where: { id: departmentId } });
        if (!department) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        await client_2.default.employeeProfile.create({
            data: {
                userId,
                departmentId,
            }
        });
        await client_2.default.user.update({
            where: { id: userId },
            data: {
                firstName: userData.firstName,
                lastName: userData.lastName,
                middleName: userData.middleName,
                currentProfileType: 'EMPLOYEE'
            }
        });
        const resProfile = await (0, userService_1.getProfile)(userId);
        res.json((0, apiResponse_1.successResponse)({
            profile: resProfile,
            message: 'Профиль сотрудника успешно создан'
        }));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания профиля сотрудника', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * @openapi
 * /users/departments:
 *   get:
 *     tags: [Users]
 *     summary: Список отделов
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Успешно
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/DepartmentMini'
 *       401: { description: Не авторизован }
 */
router.get('/departments', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const departments = await client_2.default.department.findMany({
            select: {
                id: true,
                name: true
            },
            orderBy: {
                name: 'asc'
            }
        });
        res.json((0, apiResponse_1.successResponse)(departments));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения списка отделов', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Создать отдел (для админов/управления отделами)
 */
router.post('/departments', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_departments'], { mode: 'any' }), async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        if (!name) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Название отдела обязательно', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const dep = await client_2.default.department.upsert({
            where: { name },
            update: {},
            create: { name },
        });
        res.json((0, apiResponse_1.successResponse)([{ id: dep.id, name: dep.name }]));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Обновить отдел (переименовать)
 */
router.patch('/departments/:departmentId', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_departments'], { mode: 'any' }), async (req, res) => {
    try {
        const departmentId = Number(req.params.departmentId);
        if (Number.isNaN(departmentId)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID отдела', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const name = (req.body.name || '').trim();
        if (!name) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Название отдела обязательно', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const dep = await client_2.default.department.update({
            where: { id: departmentId },
            data: { name },
        });
        res.json((0, apiResponse_1.successResponse)([{ id: dep.id, name: dep.name }]));
    }
    catch (error) {
        const isNotFound = error?.code === 'P2025';
        if (isNotFound) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Удалить отдел
 */
router.delete('/departments/:departmentId', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_departments'], { mode: 'any' }), async (req, res) => {
    try {
        const departmentId = Number(req.params.departmentId);
        if (Number.isNaN(departmentId)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID отдела', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        // Снимаем ссылки, чтобы не нарушать FK (сотрудники, роли, обращения)
        await client_2.default.employeeProfile.updateMany({ where: { departmentId }, data: { departmentId: null } });
        await client_2.default.departmentRole.deleteMany({ where: { departmentId } });
        // обращения, где отдел указан
        // Обнуляем ссылку на отдел в обращениях, чтобы не ломать FK
        await client_2.default.appeal.updateMany({
            where: { toDepartmentId: departmentId },
            data: { toDepartmentId: null },
        });
        await client_2.default.department.delete({ where: { id: departmentId } });
        res.json((0, apiResponse_1.successResponse)([{ id: departmentId, name: 'deleted' }]));
    }
    catch (error) {
        const code = error?.code;
        const msg = error?.message?.toString() || '';
        if (code === 'P2003' || msg.includes('Appeal_toDepartmentId_fkey') || msg.includes('violates RESTRICT')) {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Нельзя удалить отдел: есть связанные записи (сотрудники/роли/обращения)', apiResponse_1.ErrorCodes.CONFLICT));
        }
        if (code === 'P2025') {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        console.error('Ошибка удаления отдела', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка удаления отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * @openapi
 * /users/{userId}/department/{departmentId}/manager:
 *   post:
 *     tags: [Users]
 *     summary: Назначить пользователя менеджером отдела
 *     security:
 *       - bearerAuth: []
 *     x-roles: [admin]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: departmentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Назначение выполнено
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/MessageOnly' }
 *       400: { description: Неверные параметры }
 *       401: { description: Не авторизован }
 *       403: { description: Нет прав }
 *       404: { description: Пользователь/Отдел/Роль не найдены }
 */
router.post('/:userId/department/:departmentId/manager', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizeRoles)(['admin']), (0, audit_1.auditLog)('Админ назначил менеджера отдела'), async (req, res) => {
    try {
        const { userId, departmentId } = req.params;
        const departmentIdNum = Number(departmentId);
        if (isNaN(departmentIdNum)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID отдела', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const userIdNum = Number(userId);
        if (isNaN(userIdNum)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID пользователя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const user = await client_2.default.user.findUnique({ where: { id: userIdNum } });
        if (!user) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const department = await client_2.default.department.findUnique({ where: { id: departmentIdNum } });
        if (!department) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const managerRole = await client_2.default.role.findUnique({ where: { name: 'department_manager' } });
        if (!managerRole) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Роль "менеджер отдела" не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        await client_2.default.departmentRole.upsert({
            where: {
                userId_roleId_departmentId: {
                    userId: userIdNum,
                    roleId: managerRole.id,
                    departmentId: departmentIdNum,
                },
            },
            update: {},
            create: {
                userId: userIdNum,
                roleId: managerRole.id,
                departmentId: departmentIdNum,
            },
        });
        res.json((0, apiResponse_1.successResponse)({ message: `Пользователь ${userId} назначен менеджером отдела ${departmentId}` }));
    }
    catch (error) {
        if (error instanceof Error) {
            res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка назначения менеджера отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
        }
        else {
            res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка назначения менеджера отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
        }
    }
});
/**
 * Права (перечень)
 */
router.get('/permissions', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_permissions'], { mode: 'any' }), async (req, res) => {
    try {
        const [permissions, groups] = await Promise.all([
            client_2.default.permission.findMany({
                orderBy: { name: 'asc' },
                select: {
                    id: true,
                    name: true,
                    displayName: true,
                    description: true,
                    group: {
                        select: {
                            id: true,
                            key: true,
                            displayName: true,
                            description: true,
                            isSystem: true,
                            sortOrder: true,
                            serviceId: true,
                            service: { select: { id: true, key: true, name: true } },
                        },
                    },
                },
            }),
            client_2.default.permissionGroup.findMany({
                select: {
                    id: true,
                    key: true,
                    displayName: true,
                    description: true,
                    isSystem: true,
                    sortOrder: true,
                    serviceId: true,
                    service: { select: { id: true, key: true, name: true } },
                },
            }),
        ]);
        const groupsByKey = new Map();
        for (const group of groups) {
            groupsByKey.set(group.key, resolvePermissionGroupView({
                group,
            }));
        }
        const data = permissions.map((perm) => {
            const fromCatalog = permissionCatalog_1.PERMISSION_CATALOG_BY_NAME.get(perm.name);
            const displayName = String(perm.displayName || '').trim() || fromCatalog?.displayName || perm.name;
            const description = String(perm.description || '').trim() || fromCatalog?.description || '';
            const group = resolvePermissionGroupView({
                group: perm.group,
                fallbackGroupKey: fromCatalog?.groupKey,
                groupsByKey,
            });
            return {
                id: perm.id,
                name: perm.name,
                displayName,
                description,
                group,
            };
        });
        res.json((0, apiResponse_1.successResponse)(data));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения списка прав', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
router.get('/permission-groups', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_permissions'], { mode: 'any' }), async (_req, res) => {
    try {
        const groups = await client_2.default.permissionGroup.findMany({
            orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
            select: {
                id: true,
                key: true,
                displayName: true,
                description: true,
                isSystem: true,
                sortOrder: true,
                serviceId: true,
                service: { select: { id: true, key: true, name: true } },
            },
        });
        res.json((0, apiResponse_1.successResponse)(groups.map((group) => resolvePermissionGroupView({
            group,
        }))));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения групп прав', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
router.post('/permission-groups', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_permissions'], { mode: 'any' }), async (req, res) => {
    try {
        const key = String(req.body.key || '').trim().toLowerCase();
        const displayName = String(req.body.displayName || '').trim();
        const description = String(req.body.description || '').trim();
        const sortOrderRaw = req.body.sortOrder;
        const sortOrder = sortOrderRaw === undefined || sortOrderRaw === null ? 500 : Number(sortOrderRaw);
        const serviceIdRaw = req.body.serviceId;
        const serviceId = serviceIdRaw === undefined || serviceIdRaw === null ? null : Number(serviceIdRaw);
        if (!key) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Ключ группы обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (!/^[a-z0-9_]+$/.test(key)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Ключ группы должен быть в формате lowercase snake_case', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (!displayName) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Название группы обязательно', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (!Number.isFinite(sortOrder)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректный порядок сортировки', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (serviceIdRaw !== undefined && serviceIdRaw !== null && Number.isNaN(serviceId)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректный serviceId', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (serviceId) {
            const service = await client_2.default.service.findUnique({ where: { id: serviceId }, select: { id: true } });
            if (!service) {
                return res
                    .status(404)
                    .json((0, apiResponse_1.errorResponse)('Сервис не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
            }
        }
        const group = await client_2.default.permissionGroup.create({
            data: {
                key,
                displayName,
                description,
                sortOrder: Math.trunc(sortOrder),
                isSystem: false,
                serviceId,
            },
            select: {
                id: true,
                key: true,
                displayName: true,
                description: true,
                isSystem: true,
                sortOrder: true,
                serviceId: true,
                service: { select: { id: true, key: true, name: true } },
            },
        });
        return res.json((0, apiResponse_1.successResponse)(resolvePermissionGroupView({
            group,
        })));
    }
    catch (error) {
        if (error?.code === 'P2002') {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Группа с таким ключом уже существует', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания группы прав', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
router.patch('/permission-groups/:groupId', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_permissions'], { mode: 'any' }), async (req, res) => {
    try {
        const groupId = Number(req.params.groupId);
        if (Number.isNaN(groupId)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректный ID группы', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (req.body.key !== undefined) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Ключ группы не редактируется через API', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const existing = await client_2.default.permissionGroup.findUnique({
            where: { id: groupId },
            select: { id: true },
        });
        if (!existing) {
            return res
                .status(404)
                .json((0, apiResponse_1.errorResponse)('Группа прав не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const data = {};
        if (req.body.displayName !== undefined) {
            const displayName = String(req.body.displayName || '').trim();
            if (!displayName) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)('Название группы не может быть пустым', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            data.displayName = displayName;
        }
        if (req.body.description !== undefined) {
            data.description = String(req.body.description || '').trim();
        }
        if (req.body.sortOrder !== undefined) {
            const sortOrder = Number(req.body.sortOrder);
            if (!Number.isFinite(sortOrder)) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)('Некорректный порядок сортировки', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            data.sortOrder = Math.trunc(sortOrder);
        }
        if (!Object.keys(data).length) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Нет данных для обновления', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const group = await client_2.default.permissionGroup.update({
            where: { id: groupId },
            data,
            select: {
                id: true,
                key: true,
                displayName: true,
                description: true,
                isSystem: true,
                sortOrder: true,
                serviceId: true,
                service: { select: { id: true, key: true, name: true } },
            },
        });
        return res.json((0, apiResponse_1.successResponse)(resolvePermissionGroupView({
            group,
        })));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления группы прав', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
router.delete('/permission-groups/:groupId', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_permissions'], { mode: 'any' }), async (req, res) => {
    try {
        const groupId = Number(req.params.groupId);
        if (Number.isNaN(groupId)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректный ID группы', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const group = await client_2.default.permissionGroup.findUnique({
            where: { id: groupId },
            select: { id: true, key: true, isSystem: true },
        });
        if (!group) {
            return res
                .status(404)
                .json((0, apiResponse_1.errorResponse)('Группа прав не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (group.isSystem || group.key === permissionCatalog_1.DEFAULT_PERMISSION_GROUP_KEY) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Системную группу нельзя удалить', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const coreGroupCatalog = permissionCatalog_1.PERMISSION_GROUP_CATALOG_BY_KEY.get(permissionCatalog_1.DEFAULT_PERMISSION_GROUP_KEY);
        const coreGroup = await client_2.default.permissionGroup.upsert({
            where: { key: permissionCatalog_1.DEFAULT_PERMISSION_GROUP_KEY },
            update: {
                displayName: coreGroupCatalog?.displayName || 'Основные',
                description: coreGroupCatalog?.description || '',
                sortOrder: coreGroupCatalog?.sortOrder ?? 10,
                isSystem: true,
            },
            create: {
                key: permissionCatalog_1.DEFAULT_PERMISSION_GROUP_KEY,
                displayName: coreGroupCatalog?.displayName || 'Основные',
                description: coreGroupCatalog?.description || '',
                sortOrder: coreGroupCatalog?.sortOrder ?? 10,
                isSystem: true,
            },
            select: { id: true },
        });
        await client_2.default.$transaction([
            client_2.default.permission.updateMany({
                where: { groupId: group.id },
                data: { groupId: coreGroup.id },
            }),
            client_2.default.permissionGroup.delete({ where: { id: group.id } }),
        ]);
        return res.json((0, apiResponse_1.successResponse)({ message: 'Группа прав удалена' }));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка удаления группы прав', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
router.patch('/permissions/:permissionId/group', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_permissions'], { mode: 'any' }), async (req, res) => {
    try {
        const permissionId = Number(req.params.permissionId);
        const groupId = Number(req.body.groupId);
        if (Number.isNaN(permissionId) || Number.isNaN(groupId)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректные параметры', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const [permission, group] = await Promise.all([
            client_2.default.permission.findUnique({
                where: { id: permissionId },
                select: { id: true, name: true, displayName: true, description: true },
            }),
            client_2.default.permissionGroup.findUnique({
                where: { id: groupId },
                select: {
                    id: true,
                    key: true,
                    displayName: true,
                    description: true,
                    isSystem: true,
                    sortOrder: true,
                    serviceId: true,
                    service: { select: { id: true, key: true, name: true } },
                },
            }),
        ]);
        if (!permission) {
            return res
                .status(404)
                .json((0, apiResponse_1.errorResponse)('Право не найдено', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (!group) {
            return res
                .status(404)
                .json((0, apiResponse_1.errorResponse)('Группа прав не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const updated = await client_2.default.permission.update({
            where: { id: permission.id },
            data: { groupId: group.id },
            select: { id: true, name: true, displayName: true, description: true },
        });
        const fromCatalog = permissionCatalog_1.PERMISSION_CATALOG_BY_NAME.get(updated.name);
        const displayName = String(updated.displayName || '').trim() || fromCatalog?.displayName || updated.name;
        const description = String(updated.description || '').trim() || fromCatalog?.description || '';
        return res.json((0, apiResponse_1.successResponse)({
            id: updated.id,
            name: updated.name,
            displayName,
            description,
            group: resolvePermissionGroupView({
                group,
            }),
        }));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка переноса права в группу', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Роли: список
 */
router.get('/roles', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_roles'], { mode: 'any' }), async (req, res) => {
    try {
        const roles = await client_2.default.role.findMany({
            orderBy: { name: 'asc' },
            include: {
                parentRole: { select: { id: true, name: true, displayName: true } },
                permissions: { include: { permission: true } },
            },
        });
        const data = roles.map((r) => ({
            id: r.id,
            name: r.name,
            displayName: resolveRoleDisplayName(r.name, r.displayName),
            parentRole: r.parentRole
                ? {
                    id: r.parentRole.id,
                    name: r.parentRole.name,
                    displayName: resolveRoleDisplayName(r.parentRole.name, r.parentRole.displayName),
                }
                : null,
            permissions: r.permissions.map((p) => p.permission.name),
        }));
        res.json((0, apiResponse_1.successResponse)(data));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения списка ролей', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Админ: новый список пользователей с фильтрами/пагинацией (без breaking change старого /users)
 */
router.get('/admin/list', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_users'], { mode: 'any' }), async (req, res) => {
    try {
        const search = String(req.query.search || '').trim();
        const moderationStateRaw = String(req.query.moderationState || '').trim().toUpperCase();
        const moderationState = moderationStateRaw
            ? moderationStateRaw
            : null;
        if (moderationState && !ADMIN_MODERATION_STATE_SET.has(moderationState)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректный moderationState', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const page = toPositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
        const limit = toPositiveInt(req.query.limit, 20, { min: 1, max: 100 });
        const roleId = toOptionalInt(req.query.roleId);
        const departmentId = toOptionalInt(req.query.departmentId);
        const onlineFilter = toOnlineFilter(req.query.online);
        const sortByRaw = String(req.query.sortBy || '').trim();
        const sortBy = ADMIN_LIST_SORT_FIELDS.has(sortByRaw) ? sortByRaw : 'lastSeenAt';
        const sortDirRaw = String(req.query.sortDir || '').trim().toLowerCase();
        const sortDir = ADMIN_LIST_SORT_DIRS.has(sortDirRaw) ? sortDirRaw : 'desc';
        const where = {};
        if (search) {
            const searchPhone = (0, phone_1.normalizePhoneToBigInt)((0, phone_1.sanitizePhoneForSearch)(search));
            const searchOr = [
                { email: { contains: search, mode: 'insensitive' } },
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
            ];
            if (searchPhone)
                searchOr.push({ phone: searchPhone });
            where.OR = searchOr;
        }
        if (roleId)
            where.roleId = roleId;
        const employeeProfileFilter = {};
        if (departmentId)
            employeeProfileFilter.departmentId = departmentId;
        if (moderationState === 'EMPLOYEE_PENDING')
            employeeProfileFilter.status = 'PENDING';
        if (moderationState === 'EMPLOYEE_ACTIVE')
            employeeProfileFilter.status = 'ACTIVE';
        if (moderationState === 'EMPLOYEE_BLOCKED')
            employeeProfileFilter.status = 'BLOCKED';
        if (moderationState === 'NO_EMPLOYEE_PROFILE') {
            where.employeeProfile = null;
        }
        else if (Object.keys(employeeProfileFilter).length > 0) {
            where.employeeProfile = { is: employeeProfileFilter };
        }
        const sortCandidates = (users, presenceMap) => {
            const dir = sortDir === 'asc' ? 1 : -1;
            const statusRank = (state) => {
                if (state === 'NO_EMPLOYEE_PROFILE')
                    return 0;
                if (state === 'EMPLOYEE_PENDING')
                    return 1;
                if (state === 'EMPLOYEE_ACTIVE')
                    return 2;
                return 3;
            };
            const byName = (u) => `${u.lastName || ''} ${u.firstName || ''}`.trim().toLowerCase();
            const byEmail = (u) => String(u.email || '').toLowerCase();
            const byRole = (u) => String(u.role?.name || '');
            const byStatus = (u) => statusRank(resolveEmployeeModerationState(u.employeeProfile?.status ?? null));
            const byLastSeen = (u) => {
                const p = presenceMap.get(u.id);
                return (p?.lastSeenAt ?? u.lastSeenAt ?? null)?.getTime() || 0;
            };
            const byCreated = (u) => u.createdAt.getTime();
            users.sort((a, b) => {
                if (sortBy === 'name')
                    return byName(a).localeCompare(byName(b), 'ru') * dir;
                if (sortBy === 'email')
                    return byEmail(a).localeCompare(byEmail(b), 'ru') * dir;
                if (sortBy === 'role')
                    return byRole(a).localeCompare(byRole(b), 'ru') * dir;
                if (sortBy === 'status')
                    return (byStatus(a) - byStatus(b)) * dir;
                if (sortBy === 'createdAt')
                    return (byCreated(a) - byCreated(b)) * dir;
                return (byLastSeen(a) - byLastSeen(b)) * dir;
            });
        };
        let total = 0;
        let usersPage = [];
        let pagePresence = new Map();
        if (onlineFilter === null) {
            if (sortBy === 'status') {
                const candidateUsers = (await client_2.default.user.findMany({
                    where,
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                        lastSeenAt: true,
                        createdAt: true,
                        role: { select: { id: true, name: true, displayName: true } },
                        employeeProfile: { select: { status: true } },
                    },
                }));
                sortCandidates(candidateUsers, new Map());
                total = candidateUsers.length;
                const pageIds = candidateUsers.slice((page - 1) * limit, page * limit).map((u) => u.id);
                const users = pageIds.length
                    ? await client_2.default.user.findMany({
                        where: { id: { in: pageIds } },
                        select: ADMIN_USER_LIST_SELECT,
                    })
                    : [];
                const userById = new Map(users.map((u) => [u.id, u]));
                usersPage = pageIds.map((id) => userById.get(id)).filter(Boolean);
                const presenceRows = await (0, presenceService_1.getPresenceForUsers)(pageIds);
                pagePresence = new Map(presenceRows.map((p) => [p.userId, { isOnline: Boolean(p.isOnline), lastSeenAt: p.lastSeenAt ?? null }]));
            }
            else {
                total = await client_2.default.user.count({ where });
                const users = await client_2.default.user.findMany({
                    where,
                    select: ADMIN_USER_LIST_SELECT,
                    orderBy: buildAdminListOrder(sortBy, sortDir),
                    skip: (page - 1) * limit,
                    take: limit,
                });
                const presenceRows = await (0, presenceService_1.getPresenceForUsers)(users.map((u) => u.id));
                pagePresence = new Map(presenceRows.map((p) => [p.userId, { isOnline: Boolean(p.isOnline), lastSeenAt: p.lastSeenAt ?? null }]));
                usersPage = users;
            }
        }
        else {
            const candidateUsers = (await client_2.default.user.findMany({
                where,
                select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                    lastSeenAt: true,
                    createdAt: true,
                    role: { select: { id: true, name: true, displayName: true } },
                    employeeProfile: { select: { status: true } },
                },
            }));
            const candidatePresenceRows = await (0, presenceService_1.getPresenceForUsers)(candidateUsers.map((u) => u.id));
            const candidatePresence = new Map(candidatePresenceRows.map((p) => [p.userId, { isOnline: Boolean(p.isOnline), lastSeenAt: p.lastSeenAt ?? null }]));
            const filteredCandidates = candidateUsers.filter((u) => {
                const isOnline = candidatePresence.get(u.id)?.isOnline ?? false;
                return onlineFilter ? isOnline : !isOnline;
            });
            sortCandidates(filteredCandidates, candidatePresence);
            total = filteredCandidates.length;
            const pageIds = filteredCandidates.slice((page - 1) * limit, page * limit).map((u) => u.id);
            if (pageIds.length) {
                const users = await client_2.default.user.findMany({
                    where: { id: { in: pageIds } },
                    select: ADMIN_USER_LIST_SELECT,
                });
                const userById = new Map(users.map((u) => [u.id, u]));
                usersPage = pageIds.map((id) => userById.get(id)).filter(Boolean);
                pagePresence = new Map(pageIds.map((id) => [id, candidatePresence.get(id) ?? { isOnline: false, lastSeenAt: null }]));
            }
        }
        const items = await Promise.all(usersPage.map(async (u) => {
            const rawAvatar = u.currentProfileType === 'CLIENT'
                ? u.clientProfile?.avatarUrl
                : u.currentProfileType === 'SUPPLIER'
                    ? u.supplierProfile?.avatarUrl
                    : u.currentProfileType === 'EMPLOYEE'
                        ? u.employeeProfile?.avatarUrl
                        : u.avatarUrl;
            const avatarUrl = await (0, minio_1.resolveObjectUrl)(rawAvatar ?? null);
            const presence = pagePresence.get(u.id);
            const employeeStatus = u.employeeProfile?.status ?? null;
            const moderationState = resolveEmployeeModerationState(employeeStatus);
            return {
                id: u.id,
                email: u.email,
                firstName: u.firstName,
                lastName: u.lastName,
                middleName: u.middleName ?? null,
                phone: (0, phone_1.toApiPhoneString)(u.phone),
                avatarUrl,
                profileStatus: u.profileStatus,
                currentProfileType: u.currentProfileType,
                role: u.role
                    ? {
                        id: u.role.id,
                        name: u.role.name,
                        displayName: resolveRoleDisplayName(u.role.name, u.role.displayName),
                    }
                    : null,
                departmentName: u.employeeProfile?.department?.name ?? null,
                departmentId: u.employeeProfile?.department?.id ?? null,
                employeeStatus,
                moderationState,
                isOnline: presence?.isOnline ?? false,
                lastSeenAt: (presence?.lastSeenAt ?? u.lastSeenAt ?? null),
                channels: {
                    push: (u._count?.deviceTokens || 0) > 0,
                    telegram: Boolean(u.telegramId),
                    max: Boolean(u.maxId),
                },
                createdAt: u.createdAt,
            };
        }));
        if (sortBy === 'status' && onlineFilter === null) {
            const rank = (state) => {
                if (state === 'NO_EMPLOYEE_PROFILE')
                    return 0;
                if (state === 'EMPLOYEE_PENDING')
                    return 1;
                if (state === 'EMPLOYEE_ACTIVE')
                    return 2;
                return 3;
            };
            items.sort((a, b) => {
                const diff = rank(a.moderationState) - rank(b.moderationState);
                return sortDir === 'asc' ? diff : -diff;
            });
        }
        return res.json((0, apiResponse_1.successResponse)({
            items,
            meta: {
                page,
                limit,
                total,
                hasNext: page * limit < total,
            },
        }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения списка пользователей', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Список пользователей с поиском
 */
router.get('/', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_roles', 'manage_users'], { mode: 'any' }), async (req, res) => {
    try {
        const search = (req.query.search || '').trim();
        const searchPhone = (0, phone_1.normalizePhoneToBigInt)((0, phone_1.sanitizePhoneForSearch)(search));
        const searchOr = [
            { email: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
        ];
        if (searchPhone) {
            searchOr.push({ phone: searchPhone });
        }
        const users = await client_2.default.user.findMany({
            where: search
                ? {
                    OR: searchOr,
                }
                : {},
            select: USER_LIST_SELECT,
            orderBy: { id: 'asc' },
            take: 50,
        });
        const usersWithAvatar = await Promise.all(users.map(async (u) => {
            const rawAvatar = u.currentProfileType === 'CLIENT'
                ? u.clientProfile?.avatarUrl
                : u.currentProfileType === 'SUPPLIER'
                    ? u.supplierProfile?.avatarUrl
                    : u.currentProfileType === 'EMPLOYEE'
                        ? u.employeeProfile?.avatarUrl
                        : u.avatarUrl;
            const avatarUrl = await (0, minio_1.resolveObjectUrl)(rawAvatar ?? null);
            const departmentName = u.employeeProfile?.department?.name ?? null;
            return { ...u, avatarUrl, departmentName, phone: (0, phone_1.toApiPhoneString)(u.phone) };
        }));
        const presence = await (0, presenceService_1.getPresenceForUsers)(usersWithAvatar.map((u) => u.id));
        const presenceMap = new Map(presence.map((p) => [p.userId, p]));
        const enriched = usersWithAvatar.map((u) => {
            const p = presenceMap.get(u.id);
            return {
                ...u,
                isOnline: p?.isOnline ?? false,
                lastSeenAt: (p?.lastSeenAt ?? u.lastSeenAt ?? null),
            };
        });
        res.json((0, apiResponse_1.successResponse)(enriched));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения пользователей', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Presence ping (онлайн)
 */
router.post('/me/presence/ping', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user.userId;
        // heartbeat обновляет lastSeen, но не должен держать online=true без живого socket
        await (0, presenceService_1.markUserOnline)(userId, { touchOnline: false });
        return res.json((0, apiResponse_1.successResponse)({ ok: true }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления статуса присутствия', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Получить presence для списка пользователей
 */
router.get('/presence', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const raw = String(req.query.ids || '').trim();
        if (!raw) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Нужен параметр ids', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const ids = raw
            .split(',')
            .map((v) => Number(v))
            .filter((v) => Number.isFinite(v) && v > 0);
        if (!ids.length) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверные ids', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const presence = await (0, presenceService_1.getPresenceForUsers)(ids);
        return res.json((0, apiResponse_1.successResponse)(presence));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения статуса присутствия', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Загрузить аватар для конкретного профиля (CLIENT/SUPPLIER/EMPLOYEE)
 */
router.post('/me/profiles/:type/avatar', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, avatarUpload.single('avatar'), async (req, res) => {
    try {
        const userId = req.user.userId;
        const type = String(req.params.type || '').toUpperCase();
        const allowedTypes = ['CLIENT', 'SUPPLIER', 'EMPLOYEE'];
        if (!allowedTypes.includes(type)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Недопустимый тип профиля', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const file = req.file;
        if (!file) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Файл не найден', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const stored = await (0, minio_1.uploadMulterFile)(file, false, 'avatars');
        if (type === 'EMPLOYEE') {
            const profile = await client_2.default.employeeProfile.findUnique({ where: { userId } });
            if (!profile) {
                return res.status(404).json((0, apiResponse_1.errorResponse)('Профиль сотрудника не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
            }
            await client_2.default.employeeProfile.update({
                where: { userId },
                data: { avatarUrl: stored.key },
            });
        }
        else if (type === 'CLIENT') {
            const profile = await client_2.default.clientProfile.findUnique({ where: { userId } });
            if (!profile) {
                return res.status(404).json((0, apiResponse_1.errorResponse)('Профиль клиента не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
            }
            await client_2.default.clientProfile.update({
                where: { userId },
                data: { avatarUrl: stored.key },
            });
        }
        else if (type === 'SUPPLIER') {
            const profile = await client_2.default.supplierProfile.findUnique({ where: { userId } });
            if (!profile) {
                return res.status(404).json((0, apiResponse_1.errorResponse)('Профиль поставщика не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
            }
            await client_2.default.supplierProfile.update({
                where: { userId },
                data: { avatarUrl: stored.key },
            });
        }
        const profile = await (0, userService_1.getProfile)(userId);
        return res.json((0, apiResponse_1.successResponse)({ profile }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка загрузки аватара', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Зарегистрировать push-токен устройства
 */
router.post('/device-tokens', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const token = (req.body?.token || '').trim();
        const platform = (req.body?.platform || '').trim();
        if (!token) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется токен устройства', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const existing = await client_2.default.deviceToken.findUnique({ where: { token } });
        if (existing) {
            await client_2.default.deviceToken.update({
                where: { token },
                data: { userId, platform: platform || existing.platform || null },
            });
        }
        else {
            await client_2.default.deviceToken.create({
                data: { userId, token, platform: platform || null },
            });
        }
        return res.json((0, apiResponse_1.successResponse)({ message: 'Токен устройства сохранён' }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка сохранения токена устройства', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Удалить push-токен устройства
 */
router.delete('/device-tokens', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const token = (req.body?.token || '').trim();
        if (!token) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется токен устройства', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        await client_2.default.deviceToken.deleteMany({ where: { token, userId } });
        return res.json((0, apiResponse_1.successResponse)({ message: 'Токен устройства удалён' }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка удаления токена устройства', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * @openapi
 * /users/me/current-profile:
 *   patch:
 *     tags: [Users]
 *     summary: Выбрать активный профиль текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [CLIENT, SUPPLIER, EMPLOYEE, null]
 *     responses:
 *       200:
 *         description: Активный профиль обновлён
 *       400: { description: Неверные параметры }
 *       404: { description: Профиль не найден }
 */
router.patch('/me/current-profile', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user.userId;
        const type = req.body?.type;
        if (type === undefined) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется тип профиля', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const allowedTypes = ['CLIENT', 'SUPPLIER', 'EMPLOYEE'];
        if (type !== null && !allowedTypes.includes(type)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный тип профиля', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const user = await client_2.default.user.findUnique({
            where: { id: Number(userId) },
            include: {
                clientProfile: { select: { id: true } },
                supplierProfile: { select: { id: true } },
                employeeProfile: { select: { id: true } },
            },
        });
        if (!user) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (type !== null) {
            const hasProfile = (type === 'CLIENT' && !!user.clientProfile) ||
                (type === 'SUPPLIER' && !!user.supplierProfile) ||
                (type === 'EMPLOYEE' && !!user.employeeProfile);
            if (!hasProfile) {
                return res.status(404).json((0, apiResponse_1.errorResponse)('Профиль выбранного типа не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
            }
        }
        await client_2.default.user.update({
            where: { id: Number(userId) },
            data: { currentProfileType: type ?? null },
        });
        const profile = await (0, userService_1.getProfile)(Number(userId));
        return res.json((0, apiResponse_1.successResponse)({ profile }, 'Активный профиль обновлён'));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления активного профиля', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * @openapi
 * /users/profile:
 *   patch:
 *     tags: [Users]
 *     summary: Обновить профиль текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName: { type: string, nullable: true }
 *               lastName: { type: string, nullable: true }
 *               middleName: { type: string, nullable: true }
 *               phone: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Профиль обновлён
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile:
 *                           $ref: '#/components/schemas/UserProfile'
 *       400: { description: Неверные данные }
 *       401: { description: Не авторизован }
 *       409: { description: Email изменяется через отдельный flow подтверждения }
 */
router.patch('/profile', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, audit_1.auditLog)('Пользователь обновил профиль'), async (req, res) => {
    try {
        const userId = req.user.userId;
        const currentUser = await client_2.default.user.findUnique({
            where: { id: Number(userId) },
            select: { authProvider: true, phone: true },
        });
        if (!currentUser) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const data = {};
        const normalize = (val) => (val === null ? null : String(val).trim());
        if (req.body.firstName !== undefined) {
            const value = normalize(req.body.firstName);
            data.firstName = value || null;
        }
        if (req.body.lastName !== undefined) {
            const value = normalize(req.body.lastName);
            data.lastName = value || null;
        }
        if (req.body.middleName !== undefined) {
            const value = normalize(req.body.middleName);
            data.middleName = value || null;
        }
        if (req.body.email !== undefined) {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Email обновляется только через подтверждение кода', apiResponse_1.ErrorCodes.CONFLICT));
        }
        if (req.body.phone !== undefined) {
            const value = normalize(req.body.phone);
            if (!value) {
                data.phone = null;
                data.phoneVerifiedAt = null;
            }
            else {
                if (!(0, phone_1.normalizePhoneToBigInt)(value)) {
                    return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный формат телефона', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
                }
                return res.status(409).json((0, apiResponse_1.errorResponse)('Телефон обновляется только через подтверждение в Telegram', apiResponse_1.ErrorCodes.CONFLICT));
            }
        }
        if (Object.keys(data).length) {
            await client_2.default.user.update({ where: { id: Number(userId) }, data });
        }
        const profile = await (0, userService_1.getProfile)(Number(userId));
        return res.json((0, apiResponse_1.successResponse)({ profile }, 'Профиль обновлён'));
    }
    catch (error) {
        if (error?.code === 'P2002') {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Email уже используется', apiResponse_1.ErrorCodes.CONFLICT));
        }
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления профиля', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
router.post('/me/email/change/start', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, audit_1.auditLog)('Пользователь запросил смену email с подтверждением'), async (req, res) => {
    try {
        const userId = Number(req.user.userId);
        const email = String(req.body?.email || '').trim();
        if (!email) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Email обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const data = await (0, emailChangeService_1.startEmailChangeSession)({ userId, emailRaw: email });
        return res.json((0, apiResponse_1.successResponse)(data, 'Код подтверждения отправлен на новый email'));
    }
    catch (error) {
        const message = String(error?.message || 'Не удалось запустить смену email');
        if (message === 'EMAIL_CHANGE_INVALID_EMAIL') {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный формат email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (message === 'EMAIL_CHANGE_SAME_AS_CURRENT') {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Указан текущий email', apiResponse_1.ErrorCodes.CONFLICT));
        }
        if (message === 'EMAIL_CHANGE_CONFLICT') {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Этот email уже используется', apiResponse_1.ErrorCodes.CONFLICT));
        }
        if (message === 'EMAIL_CHANGE_USER_NOT_FOUND') {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        return res.status(500).json((0, apiResponse_1.errorResponse)(message, apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
router.get('/me/email/change/:sessionId', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = Number(req.user.userId);
        const sessionId = String(req.params.sessionId || '').trim();
        if (!sessionId) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('sessionId обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = await (0, emailChangeService_1.getEmailChangeSessionState)({ userId, sessionId });
        if (!session) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Сессия не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        return res.json((0, apiResponse_1.successResponse)({ session }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось получить статус смены email', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
router.post('/me/email/change/:sessionId/resend', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = Number(req.user.userId);
        const sessionId = String(req.params.sessionId || '').trim();
        if (!sessionId) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('sessionId обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const data = await (0, emailChangeService_1.resendEmailChangeCode)({ userId, sessionId });
        return res.json((0, apiResponse_1.successResponse)(data, 'Код подтверждения отправлен повторно'));
    }
    catch (error) {
        const message = String(error?.message || 'Не удалось отправить код повторно');
        if (message === 'EMAIL_CHANGE_SESSION_NOT_FOUND') {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Сессия не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (message === 'EMAIL_CHANGE_SESSION_NOT_ACTIVE') {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Сессия уже завершена', apiResponse_1.ErrorCodes.CONFLICT));
        }
        if (message === 'EMAIL_CHANGE_SESSION_EXPIRED') {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Сессия подтверждения истекла', apiResponse_1.ErrorCodes.CONFLICT));
        }
        if (message.startsWith('EMAIL_CHANGE_RESEND_TOO_EARLY:')) {
            const retryAfterSec = Number(message.split(':')[1] || 0);
            if (retryAfterSec > 0) {
                res.setHeader('Retry-After', String(retryAfterSec));
            }
            return res.status(429).json((0, apiResponse_1.errorResponse)(`Повторная отправка будет доступна через ${Math.max(1, retryAfterSec)} сек.`, apiResponse_1.ErrorCodes.TOO_MANY_REQUESTS));
        }
        return res.status(500).json((0, apiResponse_1.errorResponse)(message, apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
router.post('/me/email/change/:sessionId/verify', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, audit_1.auditLog)('Пользователь подтвердил смену email кодом'), async (req, res) => {
    try {
        const userId = Number(req.user.userId);
        const sessionId = String(req.params.sessionId || '').trim();
        const code = String(req.body?.code || '').trim();
        if (!sessionId) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('sessionId обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (!code) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Код подтверждения обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const result = await (0, emailChangeService_1.verifyEmailChangeSession)({ userId, sessionId, codeRaw: code });
        const profile = await (0, userService_1.getProfile)(userId);
        return res.json((0, apiResponse_1.successResponse)({ ...result, profile }, 'Email успешно подтвержден и обновлен'));
    }
    catch (error) {
        const message = String(error?.message || 'Не удалось подтвердить смену email');
        if (message === 'EMAIL_CHANGE_INVALID_CODE') {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный код подтверждения', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (message === 'EMAIL_CHANGE_TOO_MANY_ATTEMPTS') {
            return res.status(429).json((0, apiResponse_1.errorResponse)('Превышено максимальное количество попыток подтверждения', apiResponse_1.ErrorCodes.TOO_MANY_REQUESTS));
        }
        if (message === 'EMAIL_CHANGE_SESSION_NOT_FOUND') {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Сессия не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (message === 'EMAIL_CHANGE_SESSION_NOT_ACTIVE') {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Сессия уже завершена', apiResponse_1.ErrorCodes.CONFLICT));
        }
        if (message === 'EMAIL_CHANGE_SESSION_EXPIRED') {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Сессия подтверждения истекла', apiResponse_1.ErrorCodes.CONFLICT));
        }
        if (message === 'EMAIL_CHANGE_CONFLICT') {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Этот email уже используется', apiResponse_1.ErrorCodes.CONFLICT));
        }
        return res.status(500).json((0, apiResponse_1.errorResponse)(message, apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
router.post('/me/email/change/:sessionId/cancel', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = Number(req.user.userId);
        const sessionId = String(req.params.sessionId || '').trim();
        if (!sessionId) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('sessionId обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const cancelled = await (0, emailChangeService_1.cancelEmailChangeSession)({ userId, sessionId });
        return res.json((0, apiResponse_1.successResponse)({ cancelled }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось отменить смену email', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
router.post('/me/phone/verification/start', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, audit_1.auditLog)('Пользователь запросил верификацию телефона через мессенджер'), async (req, res) => {
    try {
        const userId = Number(req.user.userId);
        const phone = String(req.body?.phone || '').trim();
        const providerRaw = String(req.body?.provider || 'TELEGRAM').trim().toUpperCase();
        const provider = providerRaw === 'MAX' ? 'MAX' : 'TELEGRAM';
        if (!phone) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Телефон обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = await (0, phoneVerificationService_1.startPhoneVerificationSession)({ userId, phoneRaw: phone, provider });
        return res.json((0, apiResponse_1.successResponse)(session, 'Сессия верификации создана'));
    }
    catch (error) {
        const message = String(error?.message || 'Не удалось создать сессию верификации');
        if (/TELEGRAM_PHONE_VERIFICATION_NOT_CONFIGURED/i.test(message)) {
            return res.status(503).json((0, apiResponse_1.errorResponse)('Telegram верификация временно недоступна. Проверьте настройки TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME на сервере.', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
        }
        if (/MAX_PHONE_VERIFICATION_NOT_CONFIGURED/i.test(message)) {
            return res.status(503).json((0, apiResponse_1.errorResponse)('MAX верификация временно недоступна. Проверьте настройки MAX_BOT_TOKEN и MAX_BOT_USERNAME на сервере.', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
        }
        if (/TELEGRAM_DEEP_LINK_UNAVAILABLE/i.test(message)) {
            return res.status(503).json((0, apiResponse_1.errorResponse)('Ссылка Telegram недоступна, проверьте конфигурацию бота.', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
        }
        if (/MAX_DEEP_LINK_UNAVAILABLE/i.test(message)) {
            return res.status(503).json((0, apiResponse_1.errorResponse)('Ссылка MAX недоступна, проверьте конфигурацию бота.', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
        }
        if (/используется другим пользователем/i.test(message)) {
            return res.status(409).json((0, apiResponse_1.errorResponse)(message, apiResponse_1.ErrorCodes.CONFLICT));
        }
        if (/некорректный формат телефона/i.test(message)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)(message, apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        return res.status(500).json((0, apiResponse_1.errorResponse)(message, apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
router.get('/me/phone/verification/:sessionId', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = Number(req.user.userId);
        const sessionId = String(req.params.sessionId || '').trim();
        if (!sessionId) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('sessionId обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = await (0, phoneVerificationService_1.getPhoneVerificationSessionState)({ userId, sessionId });
        if (!session) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Сессия не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        return res.json((0, apiResponse_1.successResponse)({ session }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось получить статус верификации', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
router.post('/me/phone/verification/:sessionId/cancel', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = Number(req.user.userId);
        const sessionId = String(req.params.sessionId || '').trim();
        if (!sessionId) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('sessionId обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const cancelled = await (0, phoneVerificationService_1.cancelPhoneVerificationSession)({ userId, sessionId });
        return res.json((0, apiResponse_1.successResponse)({ cancelled }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось отменить верификацию', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
/**
 * Админ: модерация профиля сотрудника (approve/reject)
 */
router.post('/:userId/employee-moderation', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_users'], { mode: 'any' }), async (req, res) => {
    try {
        const actorUserId = Number(req.user.userId);
        const userId = Number(req.params.userId);
        if (Number.isNaN(userId)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID пользователя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const actionRaw = String(req.body?.action || '').trim().toUpperCase();
        const action = actionRaw === 'APPROVE' || actionRaw === 'REJECT' ? actionRaw : null;
        if (!action) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('action должен быть APPROVE или REJECT', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const reason = String(req.body?.reason || '').trim() || null;
        const moderation = await client_2.default.$transaction(async (tx) => {
            const user = await tx.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    role: { select: { id: true, name: true } },
                    currentProfileType: true,
                    employeeProfile: { select: { status: true } },
                },
            });
            if (!user) {
                throw new Error('USER_NOT_FOUND');
            }
            if (!user.employeeProfile) {
                throw new Error('EMPLOYEE_PROFILE_NOT_FOUND');
            }
            const [employeeRole, userRole] = await Promise.all([
                tx.role.findUnique({ where: { name: 'employee' }, select: { id: true, name: true } }),
                tx.role.findUnique({ where: { name: 'user' }, select: { id: true, name: true } }),
            ]);
            const userPatch = {};
            let nextEmployeeStatus = user.employeeProfile.status;
            let roleChanged = false;
            let currentProfileTypeReset = false;
            let roleChange = null;
            if (action === 'APPROVE') {
                nextEmployeeStatus = 'ACTIVE';
                if (user.role?.name === 'user') {
                    if (!employeeRole)
                        throw new Error('EMPLOYEE_ROLE_NOT_FOUND');
                    if (user.role.id !== employeeRole.id) {
                        userPatch.roleId = employeeRole.id;
                        roleChanged = true;
                        roleChange = { from: user.role.name, to: employeeRole.name };
                    }
                }
            }
            else {
                nextEmployeeStatus = 'BLOCKED';
                if (user.role?.name === 'employee') {
                    if (!userRole)
                        throw new Error('USER_ROLE_NOT_FOUND');
                    if (user.role.id !== userRole.id) {
                        userPatch.roleId = userRole.id;
                        roleChanged = true;
                        roleChange = { from: user.role.name, to: userRole.name };
                    }
                }
                if (user.currentProfileType === 'EMPLOYEE') {
                    userPatch.currentProfileType = null;
                    currentProfileTypeReset = true;
                }
            }
            if (nextEmployeeStatus !== user.employeeProfile.status) {
                await tx.employeeProfile.update({
                    where: { userId },
                    data: { status: nextEmployeeStatus },
                });
            }
            if (Object.keys(userPatch).length) {
                await tx.user.update({
                    where: { id: userId },
                    data: userPatch,
                });
            }
            await tx.auditLog.create({
                data: {
                    userId: actorUserId,
                    action: client_1.ActionType.UPDATE,
                    targetType: 'EMPLOYEE_MODERATION',
                    targetId: userId,
                    details: JSON.stringify({
                        action,
                        reason,
                        employeeStatusBefore: user.employeeProfile.status,
                        employeeStatusAfter: nextEmployeeStatus,
                        roleChange,
                        currentProfileTypeReset,
                    }),
                },
            });
            return {
                action,
                reason,
                employeeStatusBefore: user.employeeProfile.status,
                employeeStatusAfter: nextEmployeeStatus,
                roleChanged,
                roleChange,
                currentProfileTypeReset,
            };
        });
        const profile = await (0, userService_1.getProfile)(userId);
        const notification = await (0, profileModerationNotificationService_1.notifyEmployeeModerationResult)({ userId, action, reason }).catch((err) => {
            console.warn('[notifications] employee moderation notify failed:', err?.message || err);
            return { pushSent: false, telegramSent: false, maxSent: false, skipped: ['notification_error'] };
        });
        return res.json((0, apiResponse_1.successResponse)({
            profile,
            moderation,
            notification,
        }, action === 'APPROVE'
            ? 'Профиль сотрудника подтверждён'
            : 'Профиль сотрудника отклонён'));
    }
    catch (error) {
        const message = String(error?.message || '');
        if (message === 'USER_NOT_FOUND') {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (message === 'EMPLOYEE_PROFILE_NOT_FOUND') {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Профиль сотрудника не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (message === 'EMPLOYEE_ROLE_NOT_FOUND') {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Роль employee не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (message === 'USER_ROLE_NOT_FOUND') {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Роль user не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка модерации сотрудника', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Админ: обновить данные пользователя (ФИО, email, phone, статус, department)
 */
router.patch('/:userId', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_users'], { mode: 'any' }), async (req, res) => {
    try {
        const userId = Number(req.params.userId);
        if (Number.isNaN(userId)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID пользователя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const data = {};
        if (req.body.firstName !== undefined)
            data.firstName = req.body.firstName;
        if (req.body.lastName !== undefined)
            data.lastName = req.body.lastName;
        if (req.body.middleName !== undefined)
            data.middleName = req.body.middleName;
        if (req.body.email !== undefined)
            data.email = req.body.email;
        if (req.body.phone !== undefined) {
            const rawPhone = req.body.phone === null ? '' : String(req.body.phone).trim();
            if (!rawPhone) {
                data.phone = null;
            }
            else {
                const normalizedPhone = (0, phone_1.normalizePhoneToBigInt)(rawPhone);
                if (!normalizedPhone) {
                    return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный формат телефона', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
                }
                data.phone = normalizedPhone;
            }
        }
        if (req.body.profileStatus !== undefined)
            data.profileStatus = req.body.profileStatus;
        if (Object.keys(data).length) {
            await client_2.default.user.update({ where: { id: userId }, data });
        }
        if (req.body.departmentId !== undefined) {
            const depId = req.body.departmentId;
            if (depId === null) {
                await client_2.default.employeeProfile.updateMany({ where: { userId }, data: { departmentId: null } });
            }
            else {
                const department = await client_2.default.department.findUnique({ where: { id: Number(depId) } });
                if (!department) {
                    return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
                }
                await client_2.default.employeeProfile.updateMany({ where: { userId }, data: { departmentId: Number(depId) } });
            }
        }
        const profile = await (0, userService_1.getProfile)(userId);
        return res.json((0, apiResponse_1.successResponse)({ profile }));
    }
    catch (error) {
        const isNotFound = error?.code === 'P2025';
        if (isNotFound) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления пользователя', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Админ: смена пароля пользователя
 */
router.patch('/:userId/password', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_users'], { mode: 'any' }), async (req, res) => {
    try {
        const userId = Number(req.params.userId);
        if (Number.isNaN(userId)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID пользователя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const { password } = req.body;
        if (!password || password.length < 6) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Пароль должен быть не менее 6 символов', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const bcrypt = require('bcrypt');
        const passwordHash = await bcrypt.hash(password, 10);
        await client_2.default.user.update({ where: { id: userId }, data: { passwordHash } });
        return res.json((0, apiResponse_1.successResponse)({ message: 'Пароль обновлен' }));
    }
    catch (error) {
        const isNotFound = error?.code === 'P2025';
        if (isNotFound) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления пароля', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Создать роль
 */
router.post('/roles', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_roles'], { mode: 'any' }), async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        const displayName = (req.body.displayName || '').trim();
        if (!name) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Код роли обязателен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (!displayName) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Название роли обязательно', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const parentRoleIdRaw = req.body.parentRoleId;
        const parentRoleId = parentRoleIdRaw === null || parentRoleIdRaw === undefined ? null : Number(parentRoleIdRaw);
        if (parentRoleIdRaw !== null && parentRoleIdRaw !== undefined && Number.isNaN(parentRoleId)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректный ID родительской роли', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const parentValidation = await validateParentRoleId(parentRoleId);
        if (!parentValidation.valid) {
            return res.status(400).json((0, apiResponse_1.errorResponse)(parentValidation.message, apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const role = await client_2.default.role.create({
            data: {
                name,
                displayName,
                parentRoleId,
            },
        });
        const perms = Array.isArray(req.body.permissions) ? req.body.permissions : [];
        if (perms.length) {
            for (const permName of perms) {
                const perm = await client_2.default.permission.findUnique({ where: { name: permName } });
                if (perm) {
                    await client_2.default.rolePermissions.create({ data: { roleId: role.id, permissionId: perm.id } });
                }
            }
        }
        const createdRole = await client_2.default.role.findUnique({
            where: { id: role.id },
            select: {
                id: true,
                name: true,
                displayName: true,
                parentRole: { select: { id: true, name: true, displayName: true } },
            },
        });
        const data = createdRole
            ? {
                ...createdRole,
                displayName: resolveRoleDisplayName(createdRole.name, createdRole.displayName),
                parentRole: createdRole.parentRole
                    ? {
                        ...createdRole.parentRole,
                        displayName: resolveRoleDisplayName(createdRole.parentRole.name, createdRole.parentRole.displayName),
                    }
                    : null,
            }
            : null;
        res.json((0, apiResponse_1.successResponse)(data));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания роли', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Обновить роль (имя/parent)
 */
router.patch('/roles/:roleId', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_roles'], { mode: 'any' }), async (req, res) => {
    try {
        const roleId = Number(req.params.roleId);
        if (Number.isNaN(roleId)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID роли', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const existingRole = await client_2.default.role.findUnique({
            where: { id: roleId },
            select: { id: true, name: true },
        });
        if (!existingRole) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Роль не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (req.body.name !== undefined) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Технический код роли менять нельзя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const data = {};
        if (req.body.displayName !== undefined) {
            const displayName = String(req.body.displayName || '').trim();
            if (!displayName) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)('Название роли не может быть пустым', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            data.displayName = displayName;
        }
        if (req.body.parentRoleId !== undefined) {
            const parentRoleIdRaw = req.body.parentRoleId;
            const parentRoleId = parentRoleIdRaw === null || parentRoleIdRaw === undefined ? null : Number(parentRoleIdRaw);
            if (parentRoleIdRaw !== null && parentRoleIdRaw !== undefined && Number.isNaN(parentRoleId)) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)('Некорректный ID родительской роли', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            if (parentRoleId === roleId) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)('Роль не может быть родителем самой себя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            const parentValidation = await validateParentRoleId(parentRoleId);
            if (!parentValidation.valid) {
                return res.status(400).json((0, apiResponse_1.errorResponse)(parentValidation.message, apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            if (await wouldCreateRoleCycle(roleId, parentRoleId)) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)('Нельзя создать циклическую иерархию ролей', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            data.parentRoleId = parentRoleId;
        }
        if (!Object.keys(data).length) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Нет данных для обновления', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const role = await client_2.default.role.update({
            where: { id: roleId },
            data,
            select: {
                id: true,
                name: true,
                displayName: true,
                parentRole: { select: { id: true, name: true, displayName: true } },
            },
        });
        res.json((0, apiResponse_1.successResponse)({
            ...role,
            displayName: resolveRoleDisplayName(role.name, role.displayName),
            parentRole: role.parentRole
                ? {
                    ...role.parentRole,
                    displayName: resolveRoleDisplayName(role.parentRole.name, role.parentRole.displayName),
                }
                : null,
        }));
    }
    catch (error) {
        const isNotFound = error?.code === 'P2025';
        if (isNotFound) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Роль не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления роли', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Задать права роли
 */
router.patch('/roles/:roleId/permissions', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_permissions'], { mode: 'any' }), async (req, res) => {
    try {
        const roleId = Number(req.params.roleId);
        if (Number.isNaN(roleId)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID роли', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const permNames = Array.isArray(req.body.permissions) ? req.body.permissions : [];
        await client_2.default.rolePermissions.deleteMany({ where: { roleId } });
        if (permNames.length) {
            const perms = await client_2.default.permission.findMany({ where: { name: { in: permNames } } });
            for (const perm of perms) {
                await client_2.default.rolePermissions.create({ data: { roleId, permissionId: perm.id } });
            }
        }
        res.json((0, apiResponse_1.successResponse)({ message: 'Права роли обновлены' }));
    }
    catch (error) {
        const isNotFound = error?.code === 'P2025';
        if (isNotFound) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Роль не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления прав роли', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Удалить роль
 */
router.delete('/roles/:roleId', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_roles'], { mode: 'any' }), async (req, res) => {
    try {
        const roleId = Number(req.params.roleId);
        if (Number.isNaN(roleId)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID роли', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const role = await client_2.default.role.findUnique({
            where: { id: roleId },
            select: { id: true, name: true },
        });
        if (!role) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Роль не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (SYSTEM_ROLE_NAME_SET.has(role.name)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Базовую роль нельзя удалить', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        // Снимаем внешние связи перед удалением роли
        const baseUserRole = await client_2.default.role.findUnique({ where: { name: 'user' } });
        await client_2.default.user.updateMany({
            where: { roleId },
            data: baseUserRole?.id ? { roleId: baseUserRole.id } : { roleId: null },
        });
        await client_2.default.role.updateMany({
            where: { parentRoleId: roleId },
            data: { parentRoleId: null },
        });
        await client_2.default.departmentRole.deleteMany({ where: { roleId } });
        await client_2.default.rolePermissions.deleteMany({ where: { roleId } });
        await client_2.default.role.delete({ where: { id: roleId } });
        res.json((0, apiResponse_1.successResponse)({ message: 'Роль удалена' }));
    }
    catch (error) {
        const isNotFound = error?.code === 'P2025';
        if (isNotFound) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Роль не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка удаления роли', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Назначить основную роль пользователю
 */
router.post('/:userId/role', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['assign_roles'], { mode: 'any' }), async (req, res) => {
    try {
        const userId = Number(req.params.userId);
        if (Number.isNaN(userId)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID пользователя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        let role = null;
        if (req.body.roleId) {
            role = await client_2.default.role.findUnique({ where: { id: Number(req.body.roleId) } });
        }
        else if (req.body.roleName) {
            role = await client_2.default.role.findUnique({ where: { name: req.body.roleName } });
        }
        if (!role) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Роль не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        await client_2.default.user.update({
            where: { id: userId },
            data: { roleId: role.id },
        });
        res.json((0, apiResponse_1.successResponse)({ message: 'Роль пользователя обновлена' }));
    }
    catch (error) {
        const isNotFound = error?.code === 'P2025';
        if (isNotFound) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка назначения роли пользователю', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * @openapi
 * /users/{userId}/profile:
 *   get:
 *     tags: [Users]
 *     summary: Получить профиль пользователя по ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Профиль пользователя
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile:
 *                           $ref: '#/components/schemas/UserProfile'
 *       400: { description: Неверный ID }
 *       401: { description: Не авторизован }
 *       403: { description: Нет прав на просмотр }
 *       404: { description: Пользователь не найден }
 */
router.get('/:userId/profile', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const requestedId = Number(req.params.userId);
        if (Number.isNaN(requestedId)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректный ID пользователя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const requesterId = req.user.userId;
        const isSelf = requestedId === requesterId;
        if (!isSelf) {
            // Чужие профили могут смотреть админ и сотрудники.
            // Обычные пользователи (client/supplier без employee-контекста) — не могут.
            const requester = await client_2.default.user.findUnique({
                where: { id: requesterId },
                select: {
                    role: { select: { name: true } },
                    currentProfileType: true,
                    employeeProfile: { select: { id: true } },
                    departmentRoles: { select: { id: true }, take: 1 },
                },
            });
            const roleNameRaw = String(requester?.role?.name || '').trim().toLowerCase();
            const roleName = roleNameRaw.replace(/[\s_-]+/g, '');
            const isAdmin = roleName === 'admin' || roleName === 'administrator';
            const isEmployeeRole = roleName === 'employee' || roleName === 'departmentmanager';
            const hasEmployeeProfile = Boolean(requester?.employeeProfile);
            const hasDepartmentRole = (requester?.departmentRoles?.length || 0) > 0;
            const isEmployeeProfileActive = requester?.currentProfileType === client_1.ProfileType.EMPLOYEE;
            const canViewForeignProfile = isAdmin ||
                isEmployeeRole ||
                hasEmployeeProfile ||
                hasDepartmentRole ||
                isEmployeeProfileActive;
            if (!canViewForeignProfile) {
                return res
                    .status(403)
                    .json((0, apiResponse_1.errorResponse)('Недостаточно прав для просмотра профиля', apiResponse_1.ErrorCodes.FORBIDDEN));
            }
        }
        const profile = await (0, userService_1.getProfile)(requestedId);
        if (!profile) {
            return res
                .status(404)
                .json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        return res.json((0, apiResponse_1.successResponse)({ profile }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения профиля пользователя', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Список пользователей по отделу
 */
router.get('/departments/:departmentId/users', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_departments'], { mode: 'any' }), async (req, res) => {
    try {
        const departmentId = Number(req.params.departmentId);
        if (Number.isNaN(departmentId)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректный ID отдела', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const users = await client_2.default.user.findMany({
            where: { employeeProfile: { departmentId } },
            select: USER_LIST_SELECT,
            orderBy: { id: 'asc' },
        });
        const serialized = users.map((user) => ({
            ...user,
            phone: (0, phone_1.toApiPhoneString)(user.phone),
        }));
        return res.json((0, apiResponse_1.successResponse)(serialized));
    }
    catch (error) {
        console.error('Ошибка получения пользователей отдела', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения пользователей отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * Админ: обновить профиль пользователя (статус/адрес/отдел)
 */
router.patch('/:userId/profiles/:type', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizePermissions)(['manage_users'], { mode: 'any' }), async (req, res) => {
    try {
        const userId = Number(req.params.userId);
        if (Number.isNaN(userId)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID пользователя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const type = String(req.params.type || '').toUpperCase();
        const allowedTypes = ['CLIENT', 'SUPPLIER', 'EMPLOYEE'];
        if (!allowedTypes.includes(type)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный тип профиля', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const { status, departmentId, address } = req.body || {};
        if (status !== undefined && !Object.values(client_1.ProfileStatus).includes(status)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный статус профиля', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const ensureAddressValid = (addr) => {
            if (!addr.street || !addr.city || !addr.country) {
                return (0, apiResponse_1.errorResponse)('Для адреса обязательны поля street, city, country', apiResponse_1.ErrorCodes.VALIDATION_ERROR);
            }
            return null;
        };
        let prevStatus = null;
        let nextStatus = null;
        if (type === 'EMPLOYEE') {
            const profile = await client_2.default.employeeProfile.findUnique({ where: { userId } });
            if (!profile) {
                return res.status(404).json((0, apiResponse_1.errorResponse)('Профиль сотрудника не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
            }
            prevStatus = profile.status;
            const data = {};
            if (status !== undefined)
                data.status = status;
            if (departmentId !== undefined) {
                if (departmentId === null) {
                    data.departmentId = null;
                }
                else {
                    const dep = await client_2.default.department.findUnique({ where: { id: Number(departmentId) } });
                    if (!dep) {
                        return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
                    }
                    data.departmentId = Number(departmentId);
                }
            }
            if (!Object.keys(data).length) {
                return res.status(400).json((0, apiResponse_1.errorResponse)('Нет данных для обновления', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            await client_2.default.employeeProfile.update({ where: { userId }, data });
            nextStatus = status ?? profile.status;
        }
        else if (type === 'CLIENT') {
            const profile = await client_2.default.clientProfile.findUnique({
                where: { userId },
                include: { address: true },
            });
            if (!profile) {
                return res.status(404).json((0, apiResponse_1.errorResponse)('Клиентский профиль не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
            }
            prevStatus = profile.status;
            const data = {};
            if (status !== undefined)
                data.status = status;
            if (address !== undefined) {
                if (address === null) {
                    data.address = { disconnect: true };
                }
                else {
                    const addrErr = ensureAddressValid(address);
                    if (addrErr)
                        return res.status(400).json(addrErr);
                    data.address = profile.addressId
                        ? { update: { ...address } }
                        : { create: { ...address } };
                }
            }
            if (!Object.keys(data).length) {
                return res.status(400).json((0, apiResponse_1.errorResponse)('Нет данных для обновления', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            await client_2.default.clientProfile.update({ where: { userId }, data });
            nextStatus = status ?? profile.status;
        }
        else if (type === 'SUPPLIER') {
            const profile = await client_2.default.supplierProfile.findUnique({
                where: { userId },
                include: { address: true },
            });
            if (!profile) {
                return res.status(404).json((0, apiResponse_1.errorResponse)('Профиль поставщика не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
            }
            prevStatus = profile.status;
            const data = {};
            if (status !== undefined)
                data.status = status;
            if (address !== undefined) {
                if (address === null) {
                    data.address = { disconnect: true };
                }
                else {
                    const addrErr = ensureAddressValid(address);
                    if (addrErr)
                        return res.status(400).json(addrErr);
                    data.address = profile.addressId
                        ? { update: { ...address } }
                        : { create: { ...address } };
                }
            }
            if (!Object.keys(data).length) {
                return res.status(400).json((0, apiResponse_1.errorResponse)('Нет данных для обновления', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            await client_2.default.supplierProfile.update({ where: { userId }, data });
            nextStatus = status ?? profile.status;
        }
        if (prevStatus && nextStatus === 'ACTIVE' && prevStatus !== 'ACTIVE') {
            (0, pushService_1.notifyProfileActivated)(userId, type).catch((e) => console.warn('[push] notifyProfileActivated failed:', e));
        }
        const profile = await (0, userService_1.getProfile)(userId);
        return res.json((0, apiResponse_1.successResponse)({ profile }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления профиля пользователя', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
exports.default = router;
