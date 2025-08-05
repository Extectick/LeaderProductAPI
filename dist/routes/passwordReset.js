"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const client_1 = require("@prisma/client");
const mailService_1 = require("../services/mailService");
const apiResponse_1 = require("../utils/apiResponse");
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
const PASSWORD_RESET_CODE_EXPIRATION_MS = 60 * 60 * 1000; // 1 час
// Генерация кода — 6 цифр
function generateResetCode() {
    return crypto_1.default.randomInt(100000, 1000000).toString();
}
router.post('/password-reset/request', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            // Чтобы не давать подсказки, возвращаем 200 всегда
            return res.json((0, apiResponse_1.successResponse)(null));
        }
        // Генерируем код
        const code = generateResetCode();
        // Создаём запись в PasswordReset
        await prisma.passwordReset.create({
            data: {
                userId: user.id,
                code,
                expiresAt: new Date(Date.now() + PASSWORD_RESET_CODE_EXPIRATION_MS),
                used: false,
            },
        });
        // Отправляем email с кодом
        await (0, mailService_1.sendVerificationEmail)(email, code);
        res.json((0, apiResponse_1.successResponse)(null));
    }
    catch (error) {
        console.error('Ошибка запроса сброса пароля:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка запроса сброса пароля', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
router.post('/password-reset/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email и код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверные email или код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const resetRequest = await prisma.passwordReset.findFirst({
            where: {
                userId: user.id,
                code,
                used: false,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
        });
        if (!resetRequest) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный или просроченный код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        res.json((0, apiResponse_1.successResponse)(null));
    }
    catch (error) {
        console.error('Ошибка проверки кода сброса пароля:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка проверки кода', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
router.post('/password-reset/change', async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;
        if (!email || !code || !newPassword) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуются email, код и новый пароль', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (newPassword.length < 6) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Пароль должен быть не менее 6 символов', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверные email или код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const resetRequest = await prisma.passwordReset.findFirst({
            where: {
                userId: user.id,
                code,
                used: false,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
        });
        if (!resetRequest) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный или просроченный код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        // Хэшируем новый пароль
        const passwordHash = await bcryptjs_1.default.hash(newPassword, 10);
        // Обновляем пароль пользователя
        await prisma.user.update({
            where: { id: user.id },
            data: { passwordHash },
        });
        // Отмечаем код сброса как использованный
        await prisma.passwordReset.update({
            where: { id: resetRequest.id },
            data: { used: true },
        });
        res.json((0, apiResponse_1.successResponse)({ message: 'Пароль успешно изменён' }));
    }
    catch (error) {
        console.error('Ошибка изменения пароля:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка изменения пароля', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
exports.default = router;
