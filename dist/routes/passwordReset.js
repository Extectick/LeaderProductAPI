"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const client_1 = __importDefault(require("../prisma/client"));
const mailService_1 = require("../services/mailService");
const apiResponse_1 = require("../utils/apiResponse");
const router = (0, express_1.Router)();
const PASSWORD_RESET_CODE_EXPIRATION_MS = 60 * 60 * 1000; // 1 час
const RESET_RESEND_INTERVAL_MS = 25 * 1000; // 25 секунд
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function isValidEmail(email) {
    return EMAIL_REGEX.test(email);
}
/**
 * @openapi
 * tags:
 *   - name: Password Reset
 *     description: Сброс пароля по email с кодом подтверждения
 */
// Генерация кода — 6 цифр
function generateResetCode() {
    return crypto_1.default.randomInt(100000, 1000000).toString();
}
/**
 * @openapi
 * /password-reset/request:
 *   post:
 *     tags: [Password Reset]
 *     summary: Запрос кода для сброса пароля
 *     description: Отправляет на email 6-значный код для сброса пароля. Эндпоинт публичный.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *             required: [email]
 *     responses:
 *       200:
 *         description: Запрос принят (даже если пользователь не существует)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Некорректный запрос (нет email)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/request', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const normalizedEmail = normalizeEmail(email);
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный формат email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const user = await client_1.default.user.findFirst({
            where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
        });
        if (!user) {
            // Чтобы не давать подсказки, возвращаем 200 всегда
            return res.json((0, apiResponse_1.successResponse)(null));
        }
        const now = new Date();
        const existingReset = await client_1.default.passwordReset.findFirst({
            where: { userId: user.id, used: false },
            orderBy: { createdAt: 'desc' },
        });
        if (existingReset) {
            if (existingReset.expiresAt <= now) {
                await client_1.default.passwordReset.update({
                    where: { id: existingReset.id },
                    data: { used: true },
                });
            }
            else {
                const sinceLast = now.getTime() - existingReset.createdAt.getTime();
                if (sinceLast < RESET_RESEND_INTERVAL_MS) {
                    return res.status(429).json((0, apiResponse_1.errorResponse)('Код был отправлен недавно. Пожалуйста, подождите перед повторным запросом.', apiResponse_1.ErrorCodes.TOO_MANY_REQUESTS));
                }
                await client_1.default.passwordReset.update({
                    where: { id: existingReset.id },
                    data: { used: true },
                });
            }
        }
        // Генерируем код
        const code = generateResetCode();
        // Создаём запись в PasswordReset
        await client_1.default.passwordReset.create({
            data: {
                userId: user.id,
                code,
                expiresAt: new Date(Date.now() + PASSWORD_RESET_CODE_EXPIRATION_MS),
                used: false,
            },
        });
        // Отправляем email с кодом
        await (0, mailService_1.sendVerificationEmail)(normalizedEmail, code, 'passwordReset');
        res.json((0, apiResponse_1.successResponse)(null));
    }
    catch (error) {
        console.error('Ошибка запроса сброса пароля:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка запроса сброса пароля', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
/**
 * @openapi
 * /password-reset/verify:
 *   post:
 *     tags: [Password Reset]
 *     summary: Проверка кода сброса пароля
 *     description: Валидирует присланный по email код сброса. Эндпоинт публичный.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               code: { type: string, example: "123456" }
 *             required: [email, code]
 *     responses:
 *       200:
 *         description: Код корректный и не просрочен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Неверные email/код или код просрочен/использован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email и код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const normalizedEmail = normalizeEmail(email);
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный формат email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const trimmedCode = String(code).trim();
        if (!trimmedCode) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const user = await client_1.default.user.findFirst({
            where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
        });
        if (!user)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверные email или код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const latestReset = await client_1.default.passwordReset.findFirst({
            where: { userId: user.id, used: false },
            orderBy: { createdAt: 'desc' },
        });
        if (!latestReset || latestReset.expiresAt <= new Date()) {
            if (latestReset && latestReset.expiresAt <= new Date()) {
                await client_1.default.passwordReset.update({
                    where: { id: latestReset.id },
                    data: { used: true },
                });
            }
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный или просроченный код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (latestReset.code !== trimmedCode) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        res.json((0, apiResponse_1.successResponse)(null));
    }
    catch (error) {
        console.error('Ошибка проверки кода сброса пароля:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка проверки кода', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
/**
 * @openapi
 * /password-reset/change:
 *   post:
 *     tags: [Password Reset]
 *     summary: Смена пароля по коду
 *     description: Проверяет код и задаёт новый пароль для пользователя. Эндпоинт публичный.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               code: { type: string, example: "123456" }
 *               newPassword: { type: string, minLength: 6 }
 *             required: [email, code, newPassword]
 *     responses:
 *       200:
 *         description: Пароль успешно изменён
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
 *                         message:
 *                           type: string
 *                           example: Пароль успешно изменён
 *       400:
 *         description: Некорректные данные или неверный/просроченный код
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/change', async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;
        if (!email || !code || !newPassword) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуются email, код и новый пароль', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const normalizedEmail = normalizeEmail(email);
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный формат email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const trimmedCode = String(code).trim();
        if (!trimmedCode) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (newPassword.length < 6) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Пароль должен быть не менее 6 символов', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const user = await client_1.default.user.findFirst({
            where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
        });
        if (!user)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверные email или код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const latestReset = await client_1.default.passwordReset.findFirst({
            where: { userId: user.id, used: false },
            orderBy: { createdAt: 'desc' },
        });
        if (!latestReset || latestReset.expiresAt <= new Date()) {
            if (latestReset && latestReset.expiresAt <= new Date()) {
                await client_1.default.passwordReset.update({
                    where: { id: latestReset.id },
                    data: { used: true },
                });
            }
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный или просроченный код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (latestReset.code !== trimmedCode) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        // Хэшируем новый пароль
        const passwordHash = await bcryptjs_1.default.hash(newPassword, 10);
        // Обновляем пароль пользователя
        await client_1.default.user.update({
            where: { id: user.id },
            data: { passwordHash },
        });
        // Отмечаем код сброса как использованный
        await client_1.default.passwordReset.update({
            where: { id: latestReset.id },
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
