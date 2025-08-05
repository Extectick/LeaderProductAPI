"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const client_1 = require("@prisma/client");
const auth_1 = require("../middleware/auth");
const checkUserStatus_1 = require("../middleware/checkUserStatus");
const audit_1 = require("../middleware/audit");
const apiResponse_1 = require("../utils/apiResponse");
const userService_1 = require("../services/userService");
const router = express_1.default.Router();
const prisma = new client_1.PrismaClient();
// Обычный пользователь может назначать или изменять только свой отдел
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
        const department = await prisma.department.findUnique({ where: { id: departmentIdNum } });
        if (!department) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        await prisma.employeeProfile.updateMany({
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
// Администратор может назначить отдел любому пользователю
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
        const user = await prisma.user.findUnique({ where: { id: userIdNum } });
        if (!user) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const department = await prisma.department.findUnique({ where: { id: departmentIdNum } });
        if (!department) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        await prisma.employeeProfile.updateMany({
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
router.get('/profile', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user.userId;
        const profile = await (0, userService_1.getProfile)(userId);
        if (!profile) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        res.json((0, apiResponse_1.successResponse)({
            profile: profile
        }));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения профиля', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
// Создание клиентского профиля
router.post('/profiles/client', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { user: userData, phone, address } = req.body;
        if (!userData?.firstName) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Обязательное поле: user.firstName', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (address && (!address.street || !address.city || !address.country)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Если указан адрес, обязательные поля: address.street, address.city, address.country', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const existingProfile = await prisma.clientProfile.findUnique({ where: { userId } });
        if (existingProfile) {
            console.log(`Conflict: Client profile already exists for user ${userId}`);
            return res.status(409).json((0, apiResponse_1.errorResponse)('Клиентский профиль уже существует', apiResponse_1.ErrorCodes.CONFLICT));
        }
        let addressId;
        if (address) {
            const createdAddress = await prisma.address.create({
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
        const profile = await prisma.clientProfile.create({
            data: {
                userId,
                phone,
                ...(addressId && { addressId })
            }
        });
        await prisma.user.update({
            where: { id: userId },
            data: {
                firstName: userData.firstName,
                lastName: userData.lastName,
                middleName: userData.middleName,
                currentProfileType: 'CLIENT'
            }
        });
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                role: true,
                clientProfile: true
            }
        });
        if (!user) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const resProfile = await (0, userService_1.getProfile)(userId);
        res.json((0, apiResponse_1.successResponse)({
            profile: resProfile,
            message: 'Профиль клиента успешно создан'
        }));
    }
    catch (error) {
        console.error('Error creating client profile:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания клиентского профиля', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
// Создание профиля поставщика
router.post('/profiles/supplier', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { user: userData, phone, address } = req.body;
        if (!userData?.firstName) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Обязательное поле: user.firstName', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (address && (!address.street || !address.city || !address.country)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Если указан адрес, обязательные поля: address.street, address.city, address.country', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const existingProfile = await prisma.supplierProfile.findUnique({ where: { userId } });
        if (existingProfile) {
            console.log(`Conflict: Supplier profile already exists for user ${userId}`);
            return res.status(409).json((0, apiResponse_1.errorResponse)('Профиль поставщика уже существует', apiResponse_1.ErrorCodes.CONFLICT));
        }
        let addressId;
        if (address) {
            const createdAddress = await prisma.address.create({
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
        const profile = await prisma.supplierProfile.create({
            data: {
                userId,
                phone,
                ...(addressId && { addressId })
            }
        });
        await prisma.user.update({
            where: { id: userId },
            data: {
                firstName: userData.firstName,
                lastName: userData.lastName,
                middleName: userData.middleName,
                currentProfileType: 'SUPPLIER'
            }
        });
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                role: true,
                supplierProfile: true
            }
        });
        if (!user) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const resProfile = await (0, userService_1.getProfile)(userId);
        res.json((0, apiResponse_1.successResponse)({
            profile: resProfile,
            message: 'Профиль поставщика успешно создан'
        }));
    }
    catch (error) {
        console.error('Error creating supplier profile:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания профиля поставщика', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
// Создание профиля сотрудника
router.post('/profiles/employee', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { user: userData, phone, departmentId } = req.body;
        if (!userData?.firstName || !userData?.lastName || !departmentId) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Обязательные поля: user.firstName, user.lastName и departmentId', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const existingProfile = await prisma.employeeProfile.findUnique({ where: { userId } });
        if (existingProfile) {
            console.log(`Conflict: Employee profile already exists for user ${userId}`);
            return res.status(409).json((0, apiResponse_1.errorResponse)('Профиль сотрудника уже существует', apiResponse_1.ErrorCodes.CONFLICT));
        }
        const department = await prisma.department.findUnique({ where: { id: departmentId } });
        if (!department) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const profile = await prisma.employeeProfile.create({
            data: {
                userId,
                phone,
                departmentId,
            }
        });
        await prisma.user.update({
            where: { id: userId },
            data: {
                firstName: userData.firstName,
                lastName: userData.lastName,
                middleName: userData.middleName,
                currentProfileType: 'EMPLOYEE'
            }
        });
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                role: true,
                employeeProfile: {
                    include: {
                        department: true,
                        departmentRoles: {
                            include: {
                                role: true
                            }
                        }
                    }
                }
            }
        });
        if (!user) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const departmentRoles = (user.employeeProfile?.departmentRoles || []).map(dr => ({
            department: {
                id: dr.departmentId,
                name: user.employeeProfile?.department?.name || ''
            },
            role: dr.role
        }));
        const resProfile = await (0, userService_1.getProfile)(userId);
        res.json((0, apiResponse_1.successResponse)({
            profile: resProfile,
            message: 'Профиль сотрудника успешно создан'
        }));
    }
    catch (error) {
        console.error('Error creating employee profile:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания профиля сотрудника', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
// Обычный пользователь может назначать или изменять только свой отдел
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
        const department = await prisma.department.findUnique({ where: { id: departmentIdNum } });
        if (!department) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        await prisma.employeeProfile.updateMany({
            where: { userId },
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
// Администратор может назначить отдел любому пользователю
router.put('/:userId/department', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, auth_1.authorizeRoles)(['admin']), (0, audit_1.auditLog)('Админ обновил отдел пользователя'), async (req, res) => {
    try {
        const { userId } = req.params;
        const { departmentId } = req.body;
        const departmentIdNum = Number(departmentId);
        const userIdNum = Number(userId);
        if (isNaN(departmentIdNum) || isNaN(userIdNum)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректные параметры запроса', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const [user, department] = await Promise.all([
            prisma.user.findUnique({ where: { id: userIdNum } }),
            prisma.department.findUnique({ where: { id: departmentIdNum } })
        ]);
        if (!user || !department) {
            return res.status(404).json((0, apiResponse_1.errorResponse)(user ? 'Отдел не найден' : 'Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        await prisma.employeeProfile.updateMany({
            where: { userId: userIdNum },
            data: { departmentId: departmentIdNum },
        });
        res.json((0, apiResponse_1.successResponse)({ message: `Отдел пользователя ${userId} обновлен` }));
    }
    catch (error) {
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка назначения отдела', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
router.get('/departments', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const departments = await prisma.department.findMany({
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
// Администратор может назначить пользователя начальником отдела
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
        const user = await prisma.user.findUnique({ where: { id: userIdNum } });
        if (!user) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const department = await prisma.department.findUnique({ where: { id: departmentIdNum } });
        if (!department) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Отдел не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const managerRole = await prisma.role.findUnique({ where: { name: 'department_manager' } });
        if (!managerRole) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Роль "менеджер отдела" не найдена', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        await prisma.departmentRole.upsert({
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
exports.default = router;
