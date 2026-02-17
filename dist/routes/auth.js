"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUniqueRefreshToken = createUniqueRefreshToken;
const express_1 = __importDefault(require("express"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const client_1 = __importDefault(require("../prisma/client"));
const auth_1 = require("../middleware/auth");
const rateLimit_1 = require("../middleware/rateLimit");
const mailService_1 = require("../services/mailService");
const crypto_1 = __importStar(require("crypto"));
const apiResponse_1 = require("../utils/apiResponse");
const telegramAuthService_1 = require("../services/telegramAuthService");
const maxAuthService_1 = require("../services/maxAuthService");
const phoneVerificationService_1 = require("../services/phoneVerificationService");
const authMethodRegistry_1 = require("../services/authMethodRegistry");
const telegramBotService_1 = require("../services/telegramBotService");
const maxBotService_1 = require("../services/maxBotService");
const userService_1 = require("../services/userService");
const phone_1 = require("../utils/phone");
const redis_1 = require("../lib/redis");
const router = express_1.default.Router();
/**
 * @openapi
 * tags:
 *   - name: Auth
 *     description: Аутентификация и управление токенами
 *
 * # Примечание:
 * # - Все ответы используют унифицированные обёртки ApiSuccess/ApiError.
 * # - Для /auth/logout требуется bearer JWT.
 */
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET || 'yourrefreshtokensecret';
// временно уменьшенный TTL для access-токена (2 минуты) для отладки фона
const accessTokenLife = '30m';
const refreshTokenLife = '14d';
const MAX_FAILED_LOGIN_ATTEMPTS = 19;
const MAX_VERIFICATION_ATTEMPTS = 5;
const RESEND_CODE_INTERVAL_MS = 25 * 1000; // 25 секунд
const VERIFICATION_CODE_EXPIRATION_MS = 60 * 60 * 1000; // 1 час
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TG_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const MAX_WEBHOOK_SECRET = process.env.MAX_WEBHOOK_SECRET || '';
const TELEGRAM_RATE_LIMIT = (0, rateLimit_1.rateLimit)({ windowSec: 60, limit: 60 });
const MAX_RATE_LIMIT = (0, rateLimit_1.rateLimit)({ windowSec: 60, limit: 60 });
const WELCOME_ONCE_TTL_SEC = Number(process.env.BOT_WELCOME_ONCE_TTL_SEC || 365 * 24 * 60 * 60);
async function shouldSendWelcomeOnce(provider, userId) {
    const key = `bot:welcome:${provider}:${userId}`;
    try {
        const redis = (0, redis_1.getRedis)();
        if (!redis.isOpen)
            return true;
        const result = await redis.set(key, '1', { NX: true, EX: WELCOME_ONCE_TTL_SEC });
        return result === 'OK';
    }
    catch {
        return true;
    }
}
function tgLog(stage, payload) {
    if (process.env.NODE_ENV === 'production')
        return;
    if (payload)
        console.log('[tg-auth]', stage, payload);
    else
        console.log('[tg-auth]', stage);
}
function maxLog(stage, payload) {
    if (process.env.NODE_ENV === 'production')
        return;
    if (payload)
        console.log('[max-auth]', stage, payload);
    else
        console.log('[max-auth]', stage);
}
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function isValidEmail(email) {
    return EMAIL_REGEX.test(email);
}
function toTelegramBigInt(telegramId) {
    try {
        return BigInt(String(telegramId));
    }
    catch {
        throw new Error('Invalid telegramId');
    }
}
function toMaxBigInt(maxId) {
    try {
        return BigInt(String(maxId));
    }
    catch {
        throw new Error('Invalid maxId');
    }
}
function resolveAuthProviderAfterMessengerAttach(current) {
    switch (current) {
        case 'LOCAL':
        case 'TELEGRAM':
        case 'MAX':
        case 'HYBRID':
        default:
            return 'HYBRID';
    }
}
async function loadUserWithRolePermissions(userId) {
    return (await client_1.default.user.findUnique({
        where: { id: userId },
        include: {
            role: { include: { permissions: { include: { permission: true } } } },
            clientProfile: true,
            supplierProfile: true,
            employeeProfile: true,
        },
    }));
}
async function resolveTelegramUserState(session, phoneDigits11) {
    const telegramId = toTelegramBigInt(session.telegramId);
    const normalizedPhone = phoneDigits11 ? (0, phone_1.normalizePhoneToBigInt)(phoneDigits11) : null;
    const userByTelegram = await client_1.default.user.findFirst({
        where: { telegramId },
        select: { id: true, phone: true, telegramUsername: true },
    });
    if (userByTelegram) {
        tgLog('linked_user_found', { userId: userByTelegram.id, telegramId: session.telegramId });
        const updateData = {};
        if (session.username !== userByTelegram.telegramUsername) {
            updateData.telegramUsername = session.username;
        }
        if (Object.keys(updateData).length > 0) {
            await client_1.default.user.update({ where: { id: userByTelegram.id }, data: updateData });
        }
        if (!userByTelegram.phone && normalizedPhone) {
            const phoneOwner = await client_1.default.user.findFirst({
                where: { phone: normalizedPhone },
                select: { id: true },
            });
            if (!phoneOwner || phoneOwner.id === userByTelegram.id) {
                await client_1.default.user.update({
                    where: { id: userByTelegram.id },
                    data: { phone: normalizedPhone, phoneVerifiedAt: new Date() },
                });
            }
            else {
                tgLog('phone_conflict_ignored_for_linked_user', {
                    telegramUserId: userByTelegram.id,
                    phoneOwnerId: phoneOwner.id,
                });
            }
        }
        return { state: 'READY', userId: userByTelegram.id };
    }
    if (!normalizedPhone) {
        tgLog('phone_missing', { telegramId: session.telegramId });
        return { state: 'NEED_PHONE' };
    }
    const userByPhone = await client_1.default.user.findFirst({
        where: { phone: normalizedPhone },
        select: { id: true, email: true, phone: true, telegramId: true, authProvider: true },
    });
    if (userByPhone) {
        if (!userByPhone.telegramId || userByPhone.telegramId === telegramId) {
            const nextProvider = resolveAuthProviderAfterMessengerAttach(userByPhone.authProvider);
            await client_1.default.user.update({
                where: { id: userByPhone.id },
                data: {
                    telegramId,
                    telegramUsername: session.username,
                    telegramLinkedAt: new Date(),
                    phoneVerifiedAt: new Date(),
                    authProvider: nextProvider,
                },
            });
            tgLog('auto_linked_by_phone', { telegramId: session.telegramId, userId: userByPhone.id });
            return { state: 'READY', userId: userByPhone.id };
        }
        tgLog('need_link_by_phone', { telegramId: session.telegramId, phoneOwnerId: userByPhone.id });
        return {
            state: 'NEED_LINK',
            conflictUserHint: {
                maskedEmail: (0, telegramAuthService_1.maskEmail)(userByPhone.email),
                maskedPhone: (0, telegramAuthService_1.maskPhone)((0, phone_1.toApiPhoneString)(userByPhone.phone)),
            },
        };
    }
    const created = await client_1.default.user.create({
        data: {
            email: null,
            passwordHash: null,
            isActive: true,
            role: { connect: { name: 'user' } },
            firstName: session.firstName ?? undefined,
            lastName: session.lastName ?? undefined,
            phone: normalizedPhone,
            phoneVerifiedAt: new Date(),
            telegramId,
            telegramUsername: session.username,
            telegramLinkedAt: new Date(),
            authProvider: 'TELEGRAM',
            profileStatus: 'ACTIVE',
            currentProfileType: null,
        },
        select: { id: true },
    });
    tgLog('created_telegram_user', { userId: created.id, telegramId: session.telegramId });
    return { state: 'READY', userId: created.id };
}
async function resolveMaxUserState(session, phoneDigits11) {
    const maxId = toMaxBigInt(session.maxId);
    const normalizedPhone = phoneDigits11 ? (0, phone_1.normalizePhoneToBigInt)(phoneDigits11) : null;
    const userByMax = await client_1.default.user.findFirst({
        where: { maxId },
        select: { id: true, phone: true, maxUsername: true },
    });
    if (userByMax) {
        maxLog('linked_user_found', { userId: userByMax.id, maxId: session.maxId });
        const updateData = {};
        if (session.username !== userByMax.maxUsername) {
            updateData.maxUsername = session.username;
        }
        if (Object.keys(updateData).length > 0) {
            await client_1.default.user.update({ where: { id: userByMax.id }, data: updateData });
        }
        if (!userByMax.phone && normalizedPhone) {
            const phoneOwner = await client_1.default.user.findFirst({
                where: { phone: normalizedPhone },
                select: { id: true },
            });
            if (!phoneOwner || phoneOwner.id === userByMax.id) {
                await client_1.default.user.update({
                    where: { id: userByMax.id },
                    data: { phone: normalizedPhone, phoneVerifiedAt: new Date() },
                });
            }
            else {
                maxLog('phone_conflict_ignored_for_linked_user', {
                    maxUserId: userByMax.id,
                    phoneOwnerId: phoneOwner.id,
                });
            }
        }
        return { state: 'READY', userId: userByMax.id };
    }
    if (!normalizedPhone) {
        maxLog('phone_missing', { maxId: session.maxId });
        return { state: 'NEED_PHONE' };
    }
    const userByPhone = await client_1.default.user.findFirst({
        where: { phone: normalizedPhone },
        select: { id: true, email: true, phone: true, maxId: true, authProvider: true },
    });
    if (userByPhone) {
        if (!userByPhone.maxId || userByPhone.maxId === maxId) {
            const nextProvider = resolveAuthProviderAfterMessengerAttach(userByPhone.authProvider);
            await client_1.default.user.update({
                where: { id: userByPhone.id },
                data: {
                    maxId,
                    maxUsername: session.username,
                    maxLinkedAt: new Date(),
                    phoneVerifiedAt: new Date(),
                    authProvider: nextProvider,
                },
            });
            maxLog('auto_linked_by_phone', { maxId: session.maxId, userId: userByPhone.id });
            return { state: 'READY', userId: userByPhone.id };
        }
        maxLog('need_link_by_phone', { maxId: session.maxId, phoneOwnerId: userByPhone.id });
        return {
            state: 'NEED_LINK',
            conflictUserHint: {
                maskedEmail: (0, telegramAuthService_1.maskEmail)(userByPhone.email),
                maskedPhone: (0, telegramAuthService_1.maskPhone)((0, phone_1.toApiPhoneString)(userByPhone.phone)),
            },
        };
    }
    const created = await client_1.default.user.create({
        data: {
            email: null,
            passwordHash: null,
            isActive: true,
            role: { connect: { name: 'user' } },
            firstName: session.firstName ?? undefined,
            lastName: session.lastName ?? undefined,
            phone: normalizedPhone,
            phoneVerifiedAt: new Date(),
            maxId,
            maxUsername: session.username,
            maxLinkedAt: new Date(),
            authProvider: 'MAX',
            profileStatus: 'ACTIVE',
            currentProfileType: null,
        },
        select: { id: true },
    });
    maxLog('created_max_user', { userId: created.id, maxId: session.maxId });
    return { state: 'READY', userId: created.id };
}
async function issueAuthTokensForUser(userId) {
    const user = await loadUserWithRolePermissions(userId);
    if (!user) {
        throw new Error('Пользователь не найден');
    }
    const accessToken = generateAccessToken(user);
    const refreshToken = await createUniqueRefreshToken(user.id);
    const profile = await (0, userService_1.getProfile)(user.id);
    return { accessToken, refreshToken, profile };
}
function parseTelegramSession(tgSessionToken) {
    const parsed = (0, telegramAuthService_1.parseTelegramSessionToken)(tgSessionToken);
    return {
        telegramId: String(parsed.telegramId),
        username: parsed.username ?? null,
        firstName: parsed.firstName ?? null,
        lastName: parsed.lastName ?? null,
    };
}
function parseMaxSession(maxSessionToken) {
    const parsed = (0, maxAuthService_1.parseMaxSessionToken)(maxSessionToken);
    return {
        maxId: String(parsed.maxId),
        username: parsed.username ?? null,
        firstName: parsed.firstName ?? null,
        lastName: parsed.lastName ?? null,
    };
}
function generateAccessToken(user) {
    const payload = {
        userId: user.id,
        role: user.role.name,
        permissions: user.role.permissions.map((p) => p.permission.name),
        iat: Math.floor(Date.now() / 1000),
    };
    return jsonwebtoken_1.default.sign(payload, accessTokenSecret, {
        expiresIn: accessTokenLife,
        algorithm: 'HS256',
    });
}
function generateRefreshToken(user) {
    const payload = {
        userId: user.id,
        iat: Math.floor(Date.now() / 1000),
    };
    return jsonwebtoken_1.default.sign(payload, refreshTokenSecret, {
        expiresIn: refreshTokenLife,
        algorithm: 'HS256',
    });
}
function generateVerificationCode() {
    return crypto_1.default.randomInt(100000, 1000000).toString();
}
async function sendVerificationCodeEmail(userId, email) {
    const existingVerification = await client_1.default.emailVerification.findFirst({
        where: { userId, used: false },
        orderBy: { createdAt: 'desc' },
    });
    if (existingVerification) {
        const now = new Date();
        if (existingVerification.attemptsCount >= MAX_VERIFICATION_ATTEMPTS) {
            await client_1.default.emailVerification.update({
                where: { id: existingVerification.id },
                data: { used: true },
            });
        }
        else if (existingVerification.expiresAt <= now) {
            await client_1.default.emailVerification.update({
                where: { id: existingVerification.id },
                data: { used: true },
            });
        }
        else {
            if (existingVerification.lastSentAt &&
                now.getTime() - existingVerification.lastSentAt.getTime() < RESEND_CODE_INTERVAL_MS) {
                throw new Error('Код уже был отправлен недавно. Пожалуйста, подождите перед повторным запросом.');
            }
            await client_1.default.emailVerification.update({
                where: { id: existingVerification.id },
                data: {
                    lastSentAt: now,
                    expiresAt: new Date(now.getTime() + VERIFICATION_CODE_EXPIRATION_MS),
                },
            });
            await (0, mailService_1.sendVerificationEmail)(email, existingVerification.code, 'verification');
            return;
        }
    }
    const code = generateVerificationCode();
    await client_1.default.emailVerification.create({
        data: {
            userId,
            code,
            expiresAt: new Date(Date.now() + VERIFICATION_CODE_EXPIRATION_MS),
            used: false,
            attemptsCount: 0,
            lastSentAt: new Date(),
        },
    });
    await (0, mailService_1.sendVerificationEmail)(email, code, 'verification');
}
function generateSecureRandomToken(length = 64) {
    return crypto_1.default.randomBytes(length).toString('hex'); // 128-символьный строковый токен
}
// Функция создания уникального refresh токена с повтором при коллизии
async function createUniqueRefreshToken(userId) {
    const jti = (0, crypto_1.randomUUID)(); // Гарантирует уникальность
    const token = jsonwebtoken_1.default.sign({ userId, jti }, refreshTokenSecret, { expiresIn: '30d' });
    await client_1.default.refreshToken.create({
        data: {
            token,
            userId,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
    });
    return token;
}
/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Регистрация нового пользователя
 *     description: Создаёт пользователя и отправляет код подтверждения email.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 6 }
 *             required: [email, password]
 *     responses:
 *       201:
 *         description: Зарегистрирован, код отправлен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       200:
 *         description: Пользователь уже есть, но не активирован — код переотправлен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       409:
 *         description: Пользователь уже существует
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       429:
 *         description: Слишком частые запросы кода подтверждения
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email и пароль', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const normalizedEmail = normalizeEmail(email);
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный формат email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (password.length < 6)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Пароль должен быть не менее 6 символов', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const existingUser = await client_1.default.user.findFirst({
            where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
        });
        if (existingUser) {
            if (!existingUser.isActive) {
                if (!existingUser.email) {
                    return res.status(409).json((0, apiResponse_1.errorResponse)('Аккаунт зарегистрирован через Telegram. Войдите через Telegram.', apiResponse_1.ErrorCodes.CONFLICT));
                }
                await sendVerificationCodeEmail(existingUser.id, existingUser.email);
                return res.status(200).json((0, apiResponse_1.successResponse)(null, 'Пользователь уже зарегистрирован, но не активирован. Код подтверждения отправлен повторно.'));
            }
            return res.status(409).json((0, apiResponse_1.errorResponse)('Пользователь уже существует', apiResponse_1.ErrorCodes.CONFLICT));
        }
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        const user = await client_1.default.user.create({
            data: {
                email: normalizedEmail,
                passwordHash,
                isActive: false,
                role: { connect: { name: 'user' } },
                firstName: typeof name === 'string' && name.trim() ? name.trim() : undefined,
            },
        });
        await sendVerificationCodeEmail(user.id, normalizedEmail);
        res.status(201).json((0, apiResponse_1.successResponse)(null, 'Пользователь зарегистрирован. Пожалуйста, подтвердите email.'));
    }
    catch (error) {
        if (error.message && /recently|недавно/i.test(error.message)) {
            return res.status(429).json((0, apiResponse_1.errorResponse)(error.message, apiResponse_1.ErrorCodes.TOO_MANY_REQUESTS));
        }
        console.error('Ошибка регистрации:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка регистрации', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
/**
 * @openapi
 * /auth/resend:
 *   post:
 *     tags: [Auth]
 *     summary: Повторная отправка кода подтверждения
 *     description: Отправляет новый код подтверждения, если аккаунт ещё не активирован.
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
 *         description: Код отправлен повторно
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации или аккаунт уже активирован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       429:
 *         description: Слишком частые запросы
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/resend', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const normalizedEmail = normalizeEmail(email);
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный формат email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const user = await client_1.default.user.findFirst({
            where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
        });
        if (!user) {
            return res.json((0, apiResponse_1.successResponse)(null, 'Если аккаунт существует, код подтверждения отправлен.'));
        }
        if (user.isActive) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Аккаунт уже активирован', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (!user.email) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Для Telegram-аккаунта email не задан', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        await sendVerificationCodeEmail(user.id, normalizedEmail);
        return res.json((0, apiResponse_1.successResponse)(null, 'Код подтверждения отправлен повторно.'));
    }
    catch (error) {
        if (error.message && /recently|недавно/i.test(error.message)) {
            return res.status(429).json((0, apiResponse_1.errorResponse)(error.message, apiResponse_1.ErrorCodes.TOO_MANY_REQUESTS));
        }
        console.error('Ошибка повторной отправки кода:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка отправки кода подтверждения', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
router.get('/methods', async (_req, res) => {
    return res.json((0, apiResponse_1.successResponse)({ methods: (0, authMethodRegistry_1.getAuthMethodDescriptors)() }));
});
router.post('/telegram/init', TELEGRAM_RATE_LIMIT, async (req, res) => {
    try {
        const { initDataRaw } = req.body;
        if (!initDataRaw || typeof initDataRaw !== 'string') {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется initDataRaw', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const telegramUser = (0, telegramAuthService_1.verifyTelegramInitData)(initDataRaw);
        const tgSessionToken = (0, telegramAuthService_1.issueTelegramSessionToken)(telegramUser);
        const phoneFromBot = await (0, telegramAuthService_1.getTelegramContactPhone)(telegramUser.id);
        const resolved = await resolveTelegramUserState({
            telegramId: telegramUser.id,
            username: telegramUser.username,
            firstName: telegramUser.firstName,
            lastName: telegramUser.lastName,
        }, phoneFromBot);
        return res.json((0, apiResponse_1.successResponse)({
            tgSessionToken,
            telegramUser: {
                id: telegramUser.id,
                username: telegramUser.username,
                firstName: telegramUser.firstName,
                lastName: telegramUser.lastName,
            },
            state: resolved.state,
            conflictUserHint: resolved.conflictUserHint ?? null,
        }));
    }
    catch (error) {
        return res.status(401).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось проверить Telegram initData', apiResponse_1.ErrorCodes.UNAUTHORIZED));
    }
});
router.post('/telegram/contact', TELEGRAM_RATE_LIMIT, async (req, res) => {
    try {
        const { tgSessionToken, phoneE164 } = req.body;
        if (!tgSessionToken || !phoneE164) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуются tgSessionToken и phoneE164', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = parseTelegramSession(tgSessionToken);
        const normalizedPhone = (0, telegramAuthService_1.normalizePhoneE164)(phoneE164);
        if (!normalizedPhone) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный формат телефона', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        await (0, telegramAuthService_1.setTelegramContactPhone)(session.telegramId, normalizedPhone);
        const resolved = await resolveTelegramUserState(session, normalizedPhone);
        return res.json((0, apiResponse_1.successResponse)({
            state: resolved.state === 'AUTHORIZED' ? 'NEED_PHONE' : resolved.state,
            conflictUserHint: resolved.conflictUserHint ?? null,
        }));
    }
    catch (error) {
        return res.status(401).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось сохранить контакт', apiResponse_1.ErrorCodes.UNAUTHORIZED));
    }
});
router.get('/telegram/contact-status', TELEGRAM_RATE_LIMIT, async (req, res) => {
    try {
        const tgSessionToken = String(req.query?.tgSessionToken || '').trim();
        if (!tgSessionToken) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется tgSessionToken', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = parseTelegramSession(tgSessionToken);
        const phoneFromBot = await (0, telegramAuthService_1.getTelegramContactPhone)(session.telegramId);
        const resolved = await resolveTelegramUserState(session, phoneFromBot);
        return res.json((0, apiResponse_1.successResponse)({
            state: resolved.state,
            conflictUserHint: resolved.conflictUserHint ?? null,
        }));
    }
    catch (error) {
        return res.status(401).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось проверить статус контакта', apiResponse_1.ErrorCodes.UNAUTHORIZED));
    }
});
router.post('/telegram/sign-in', TELEGRAM_RATE_LIMIT, async (req, res) => {
    try {
        const { tgSessionToken } = req.body;
        if (!tgSessionToken) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется tgSessionToken', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = parseTelegramSession(tgSessionToken);
        const telegramId = toTelegramBigInt(session.telegramId);
        const linkedUser = await client_1.default.user.findFirst({
            where: { telegramId },
            select: { id: true, profileStatus: true, telegramUsername: true },
        });
        if (!linkedUser) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Telegram аккаунт не привязан', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (linkedUser.profileStatus === 'BLOCKED') {
            return res.status(403).json((0, apiResponse_1.errorResponse)('Ваш аккаунт заблокирован. Обратитесь в поддержку.', apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        if (session.username !== linkedUser.telegramUsername) {
            await client_1.default.user.update({
                where: { id: linkedUser.id },
                data: { telegramUsername: session.username },
            });
        }
        const authPayload = await issueAuthTokensForUser(linkedUser.id);
        return res.json((0, apiResponse_1.successResponse)({ ...authPayload, message: 'Вход через Telegram успешен' }));
    }
    catch (error) {
        return res.status(401).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось выполнить вход через Telegram', apiResponse_1.ErrorCodes.UNAUTHORIZED));
    }
});
router.post('/telegram/link', TELEGRAM_RATE_LIMIT, auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user?.userId;
        const tgSessionToken = String(req.body?.tgSessionToken || '').trim();
        if (!userId) {
            return res.status(401).json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        if (!tgSessionToken) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется tgSessionToken', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = parseTelegramSession(tgSessionToken);
        const telegramId = toTelegramBigInt(session.telegramId);
        const owner = await client_1.default.user.findFirst({
            where: { telegramId },
            select: { id: true },
        });
        if (owner && owner.id !== Number(userId)) {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Этот Telegram аккаунт уже привязан к другому пользователю', apiResponse_1.ErrorCodes.CONFLICT));
        }
        const current = await client_1.default.user.findUnique({
            where: { id: Number(userId) },
            select: { authProvider: true },
        });
        if (!current) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const nextProvider = resolveAuthProviderAfterMessengerAttach(current.authProvider);
        await client_1.default.user.update({
            where: { id: Number(userId) },
            data: {
                telegramId,
                telegramUsername: session.username,
                telegramLinkedAt: new Date(),
                authProvider: nextProvider,
            },
        });
        const profile = await (0, userService_1.getProfile)(Number(userId));
        return res.json((0, apiResponse_1.successResponse)({ profile }, 'Telegram аккаунт успешно привязан'));
    }
    catch (error) {
        return res.status(401).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось привязать Telegram аккаунт', apiResponse_1.ErrorCodes.UNAUTHORIZED));
    }
});
router.post('/max/init', MAX_RATE_LIMIT, async (req, res) => {
    try {
        const { initDataRaw } = req.body;
        if (!initDataRaw || typeof initDataRaw !== 'string') {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется initDataRaw', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const maxUser = (0, maxAuthService_1.verifyMaxInitData)(initDataRaw);
        const maxSessionToken = (0, maxAuthService_1.issueMaxSessionToken)(maxUser);
        const phoneFromBot = await (0, maxAuthService_1.getMaxContactPhone)(maxUser.id);
        const resolved = await resolveMaxUserState({
            maxId: maxUser.id,
            username: maxUser.username,
            firstName: maxUser.firstName,
            lastName: maxUser.lastName,
        }, phoneFromBot);
        return res.json((0, apiResponse_1.successResponse)({
            maxSessionToken,
            maxUser: {
                id: maxUser.id,
                username: maxUser.username,
                firstName: maxUser.firstName,
                lastName: maxUser.lastName,
            },
            state: resolved.state,
            conflictUserHint: resolved.conflictUserHint ?? null,
        }));
    }
    catch (error) {
        return res.status(401).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось проверить MAX initData', apiResponse_1.ErrorCodes.UNAUTHORIZED));
    }
});
router.post('/max/contact', MAX_RATE_LIMIT, async (req, res) => {
    try {
        const { maxSessionToken, phoneE164 } = req.body;
        if (!maxSessionToken || !phoneE164) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуются maxSessionToken и phoneE164', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = parseMaxSession(maxSessionToken);
        const normalizedPhone = (0, telegramAuthService_1.normalizePhoneE164)(phoneE164);
        if (!normalizedPhone) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный формат телефона', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        await (0, maxAuthService_1.setMaxContactPhone)(session.maxId, normalizedPhone);
        const resolved = await resolveMaxUserState(session, normalizedPhone);
        return res.json((0, apiResponse_1.successResponse)({
            state: resolved.state === 'AUTHORIZED' ? 'NEED_PHONE' : resolved.state,
            conflictUserHint: resolved.conflictUserHint ?? null,
        }));
    }
    catch (error) {
        return res.status(401).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось сохранить контакт', apiResponse_1.ErrorCodes.UNAUTHORIZED));
    }
});
router.get('/max/contact-status', MAX_RATE_LIMIT, async (req, res) => {
    try {
        const maxSessionToken = String(req.query?.maxSessionToken || '').trim();
        if (!maxSessionToken) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется maxSessionToken', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = parseMaxSession(maxSessionToken);
        const phoneFromBot = await (0, maxAuthService_1.getMaxContactPhone)(session.maxId);
        const resolved = await resolveMaxUserState(session, phoneFromBot);
        return res.json((0, apiResponse_1.successResponse)({
            state: resolved.state,
            conflictUserHint: resolved.conflictUserHint ?? null,
        }));
    }
    catch (error) {
        return res.status(401).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось проверить статус контакта', apiResponse_1.ErrorCodes.UNAUTHORIZED));
    }
});
router.post('/max/sign-in', MAX_RATE_LIMIT, async (req, res) => {
    try {
        const { maxSessionToken } = req.body;
        if (!maxSessionToken) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется maxSessionToken', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = parseMaxSession(maxSessionToken);
        const maxId = toMaxBigInt(session.maxId);
        const linkedUser = await client_1.default.user.findFirst({
            where: { maxId },
            select: { id: true, profileStatus: true, maxUsername: true },
        });
        if (!linkedUser) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('MAX аккаунт не привязан', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (linkedUser.profileStatus === 'BLOCKED') {
            return res.status(403).json((0, apiResponse_1.errorResponse)('Ваш аккаунт заблокирован. Обратитесь в поддержку.', apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        if (session.username !== linkedUser.maxUsername) {
            await client_1.default.user.update({
                where: { id: linkedUser.id },
                data: { maxUsername: session.username },
            });
        }
        const authPayload = await issueAuthTokensForUser(linkedUser.id);
        return res.json((0, apiResponse_1.successResponse)({ ...authPayload, message: 'Вход через MAX успешен' }));
    }
    catch (error) {
        return res.status(401).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось выполнить вход через MAX', apiResponse_1.ErrorCodes.UNAUTHORIZED));
    }
});
router.post('/max/link', MAX_RATE_LIMIT, auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user?.userId;
        const maxSessionToken = String(req.body?.maxSessionToken || '').trim();
        if (!userId) {
            return res.status(401).json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        if (!maxSessionToken) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется maxSessionToken', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const session = parseMaxSession(maxSessionToken);
        const maxId = toMaxBigInt(session.maxId);
        const owner = await client_1.default.user.findFirst({
            where: { maxId },
            select: { id: true },
        });
        if (owner && owner.id !== Number(userId)) {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Этот MAX аккаунт уже привязан к другому пользователю', apiResponse_1.ErrorCodes.CONFLICT));
        }
        const current = await client_1.default.user.findUnique({
            where: { id: Number(userId) },
            select: { authProvider: true },
        });
        if (!current) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        const nextProvider = resolveAuthProviderAfterMessengerAttach(current.authProvider);
        await client_1.default.user.update({
            where: { id: Number(userId) },
            data: {
                maxId,
                maxUsername: session.username,
                maxLinkedAt: new Date(),
                authProvider: nextProvider,
            },
        });
        const profile = await (0, userService_1.getProfile)(Number(userId));
        return res.json((0, apiResponse_1.successResponse)({ profile }, 'MAX аккаунт успешно привязан'));
    }
    catch (error) {
        return res.status(401).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось привязать MAX аккаунт', apiResponse_1.ErrorCodes.UNAUTHORIZED));
    }
});
router.post('/credentials', TELEGRAM_RATE_LIMIT, auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуются email и пароль', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const normalizedEmail = normalizeEmail(email);
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный формат email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (password.length < 6) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Пароль должен быть не менее 6 символов', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const me = await client_1.default.user.findUnique({
            where: { id: Number(userId) },
            select: { id: true, email: true, telegramId: true, maxId: true, authProvider: true },
        });
        if (!me) {
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (me.email && normalizeEmail(me.email) !== normalizedEmail) {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Email уже задан. Измените его в профиле.', apiResponse_1.ErrorCodes.CONFLICT));
        }
        const conflict = await client_1.default.user.findFirst({
            where: {
                email: { equals: normalizedEmail, mode: 'insensitive' },
                id: { not: Number(userId) },
            },
            select: { id: true },
        });
        if (conflict) {
            return res.status(409).json((0, apiResponse_1.errorResponse)('Этот email уже используется', apiResponse_1.ErrorCodes.CONFLICT));
        }
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        const nextProvider = me.telegramId || me.maxId ? 'HYBRID' : me.authProvider;
        await client_1.default.user.update({
            where: { id: Number(userId) },
            data: {
                email: normalizedEmail,
                passwordHash,
                authProvider: nextProvider,
                isActive: false,
            },
        });
        await sendVerificationCodeEmail(Number(userId), normalizedEmail);
        return res.json((0, apiResponse_1.successResponse)(null, 'Учётные данные добавлены. Подтвердите email, чтобы включить вход по паролю.'));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)(error?.message || 'Не удалось добавить email и пароль', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
async function processTelegramPhoneVerificationUpdate(update) {
    const message = update?.message || update?.edited_message || null;
    const fromIdRaw = message?.from?.id ?? message?.contact?.user_id ?? null;
    const chatIdRaw = message?.chat?.id ?? null;
    const username = message?.from?.username ? String(message.from.username) : null;
    const textRaw = String(message?.text || '').trim();
    if (fromIdRaw && textRaw.startsWith('/start')) {
        const payload = textRaw.split(/\s+/, 2)[1] || '';
        const token = payload.startsWith('verify_phone_') ? payload.slice('verify_phone_'.length) : '';
        if (token) {
            tgLog('phone_verify_start_received', { fromIdRaw: String(fromIdRaw), hasChatId: chatIdRaw !== null && chatIdRaw !== undefined });
            const session = await (0, phoneVerificationService_1.bindTelegramToPhoneVerificationByStartToken)({
                token,
                telegramUserId: String(fromIdRaw),
                chatId: chatIdRaw !== null && chatIdRaw !== undefined ? String(chatIdRaw) : null,
                username,
            });
            tgLog('phone_verify_start_bound', {
                sessionId: session?.id ?? null,
                sessionStatus: session?.status ?? null,
            });
            if (chatIdRaw !== null && chatIdRaw !== undefined) {
                const chatId = String(chatIdRaw);
                if (!session) {
                    await (0, telegramBotService_1.sendTelegramInfoMessage)({
                        chatId,
                        text: 'Ссылка подтверждения недействительна. Запустите подтверждение номера заново в приложении.',
                        removeKeyboard: true,
                    }).catch((e) => tgLog('bot_send_failed', { stage: 'start_invalid', error: String(e?.message || e) }));
                }
                else if (session.status === 'PENDING') {
                    await (0, telegramBotService_1.sendPhoneContactRequestMessage)({
                        chatId,
                        requestedPhone: (0, phone_1.toApiPhoneString)(session.requestedPhone),
                    }).catch((e) => tgLog('bot_send_failed', { stage: 'start_pending', error: String(e?.message || e) }));
                }
                else if (session.status === 'EXPIRED') {
                    await (0, telegramBotService_1.sendTelegramInfoMessage)({
                        chatId,
                        text: 'Сессия подтверждения истекла. Запустите подтверждение заново в приложении.',
                        removeKeyboard: true,
                    }).catch((e) => tgLog('bot_send_failed', { stage: 'start_expired', error: String(e?.message || e) }));
                }
                else {
                    await (0, telegramBotService_1.sendTelegramInfoMessage)({
                        chatId,
                        text: 'Эта сессия подтверждения уже завершена.',
                        removeKeyboard: true,
                    }).catch((e) => tgLog('bot_send_failed', { stage: 'start_already_done', error: String(e?.message || e) }));
                }
            }
        }
        else if (chatIdRaw !== null && chatIdRaw !== undefined) {
            const shouldSend = await shouldSendWelcomeOnce('telegram', String(fromIdRaw));
            if (shouldSend) {
                await (0, telegramBotService_1.sendTelegramWelcomeMessage)({
                    chatId: String(chatIdRaw),
                    startParam: 'home',
                }).catch((e) => tgLog('bot_send_failed', { stage: 'start_welcome', error: String(e?.message || e) }));
            }
        }
    }
    const phoneRaw = message?.contact?.phone_number ?? null;
    if (!fromIdRaw || !phoneRaw) {
        return;
    }
    const normalized = (0, telegramAuthService_1.normalizePhoneE164)(String(phoneRaw));
    if (!normalized)
        return;
    await (0, telegramAuthService_1.setTelegramContactPhone)(String(fromIdRaw), normalized);
    const verification = await (0, phoneVerificationService_1.verifyPhoneByTelegramContact)({
        telegramUserId: String(fromIdRaw),
        phoneRaw: String(phoneRaw),
        username,
    });
    if (!verification.ok && verification.reason === 'SESSION_NOT_FOUND') {
        tgLog('contact_without_session', { telegramUserId: String(fromIdRaw) });
        return;
    }
    if (chatIdRaw !== null && chatIdRaw !== undefined) {
        const chatId = String(chatIdRaw);
        if (verification.ok) {
            await (0, telegramBotService_1.sendTelegramInfoMessage)({
                chatId,
                text: 'Номер телефона подтверждён. Можно вернуться в приложение.',
                removeKeyboard: true,
            }).catch((e) => tgLog('bot_send_failed', { stage: 'verified', error: String(e?.message || e) }));
        }
        else if (verification.reason === 'PHONE_MISMATCH') {
            await (0, telegramBotService_1.sendTelegramInfoMessage)({
                chatId,
                text: 'Отправлен другой номер. Нажмите кнопку и отправьте контакт с нужным номером.',
            }).catch((e) => tgLog('bot_send_failed', { stage: 'phone_mismatch', error: String(e?.message || e) }));
        }
        else if (verification.reason === 'SESSION_NOT_FOUND' || verification.reason === 'SESSION_EXPIRED') {
            await (0, telegramBotService_1.sendTelegramInfoMessage)({
                chatId,
                text: 'Сессия подтверждения не найдена или истекла. Запустите подтверждение заново в приложении.',
                removeKeyboard: true,
            }).catch((e) => tgLog('bot_send_failed', { stage: 'session_not_found_or_expired', error: String(e?.message || e) }));
        }
        else if (verification.reason === 'PHONE_ALREADY_USED') {
            await (0, telegramBotService_1.sendTelegramInfoMessage)({
                chatId,
                text: 'Этот номер уже используется другим пользователем.',
                removeKeyboard: true,
            }).catch((e) => tgLog('bot_send_failed', { stage: 'phone_already_used', error: String(e?.message || e) }));
        }
        else if (verification.reason === 'TELEGRAM_ALREADY_USED') {
            await (0, telegramBotService_1.sendTelegramInfoMessage)({
                chatId,
                text: 'Этот Telegram-аккаунт уже привязан к другому пользователю.',
                removeKeyboard: true,
            }).catch((e) => tgLog('bot_send_failed', { stage: 'telegram_already_used', error: String(e?.message || e) }));
        }
        else {
            await (0, telegramBotService_1.sendTelegramInfoMessage)({
                chatId,
                text: 'Не удалось подтвердить номер. Попробуйте снова из приложения.',
            }).catch((e) => tgLog('bot_send_failed', { stage: 'unknown_verification_error', error: String(e?.message || e) }));
        }
    }
}
(0, telegramBotService_1.registerTelegramUpdateHandler)(processTelegramPhoneVerificationUpdate);
router.post('/telegram/webhook', async (req, res) => {
    try {
        if (TG_WEBHOOK_SECRET) {
            const header = String(req.headers['x-telegram-bot-api-secret-token'] || '');
            if (!header || header !== TG_WEBHOOK_SECRET) {
                return res.status(403).json((0, apiResponse_1.errorResponse)('Forbidden', apiResponse_1.ErrorCodes.FORBIDDEN));
            }
        }
        await processTelegramPhoneVerificationUpdate(req.body || {});
        return res.json((0, apiResponse_1.successResponse)({ ok: true }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)(error?.message || 'Webhook processing failed', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
function extractPhoneFromVcf(vcfInfo) {
    const raw = String(vcfInfo || '').trim();
    if (!raw)
        return null;
    const lines = raw.split(/\r?\n/);
    const telLine = lines.find((line) => /^TEL/i.test(line.trim()));
    if (!telLine)
        return null;
    const phoneRaw = telLine.split(':').slice(1).join(':').trim();
    return phoneRaw || null;
}
function parseMaxUpdatePayload(update) {
    const updateType = String(update?.update_type || '').trim().toLowerCase();
    const message = update?.message || null;
    const fromIdRaw = update?.user?.user_id ??
        message?.sender?.user_id ??
        null;
    const chatIdRaw = update?.chat_id ??
        message?.recipient?.chat_id ??
        null;
    const username = update?.user?.username || message?.sender?.username
        ? String(update?.user?.username || message?.sender?.username)
        : null;
    const textRaw = String(message?.body?.text || '').trim();
    let startPayload = '';
    if (updateType === 'bot_started') {
        startPayload = String(update?.payload || '').trim();
    }
    else if (textRaw.startsWith('/start')) {
        startPayload = textRaw.split(/\s+/, 2)[1] || '';
    }
    const startToken = startPayload.startsWith('verify_phone_')
        ? startPayload.slice('verify_phone_'.length)
        : '';
    let phoneRaw = null;
    const attachments = Array.isArray(message?.body?.attachments) ? message.body.attachments : [];
    for (const att of attachments) {
        if (att?.type !== 'contact')
            continue;
        const fromVcf = extractPhoneFromVcf(String(att?.payload?.vcf_info || ''));
        if (fromVcf) {
            phoneRaw = fromVcf;
            break;
        }
    }
    return { fromIdRaw, chatIdRaw, username, startToken, phoneRaw };
}
async function processMaxPhoneVerificationUpdate(update) {
    const parsed = parseMaxUpdatePayload(update);
    const fromIdRaw = parsed.fromIdRaw;
    const username = parsed.username;
    const targetChatId = parsed.fromIdRaw ?? null;
    const isStartEvent = String(update?.update_type || '').trim().toLowerCase() === 'bot_started' ||
        String(update?.message?.body?.text || '').trim().startsWith('/start');
    if (fromIdRaw && parsed.startToken) {
        maxLog('phone_verify_start_received', {
            fromIdRaw: String(fromIdRaw),
            hasChatId: parsed.chatIdRaw !== null && parsed.chatIdRaw !== undefined,
        });
        const session = await (0, phoneVerificationService_1.bindMaxToPhoneVerificationByStartToken)({
            token: parsed.startToken,
            maxUserId: String(fromIdRaw),
            chatId: parsed.chatIdRaw !== null && parsed.chatIdRaw !== undefined ? String(parsed.chatIdRaw) : null,
            username,
        });
        maxLog('phone_verify_start_bound', {
            sessionId: session?.id ?? null,
            sessionStatus: session?.status ?? null,
        });
        if (targetChatId !== null && targetChatId !== undefined) {
            const chatId = String(targetChatId);
            if (!session) {
                await (0, maxBotService_1.sendMaxInfoMessage)({
                    chatId,
                    text: 'Ссылка подтверждения недействительна. Запустите подтверждение номера заново в приложении.',
                }).catch((e) => maxLog('bot_send_failed', { stage: 'start_invalid', error: String(e?.message || e) }));
            }
            else if (session.status === 'PENDING') {
                await (0, maxBotService_1.sendMaxPhoneContactRequestMessage)({
                    chatId,
                    requestedPhone: (0, phone_1.toApiPhoneString)(session.requestedPhone),
                }).catch((e) => maxLog('bot_send_failed', { stage: 'start_pending', error: String(e?.message || e) }));
            }
            else if (session.status === 'EXPIRED') {
                await (0, maxBotService_1.sendMaxInfoMessage)({
                    chatId,
                    text: 'Сессия подтверждения истекла. Запустите подтверждение заново в приложении.',
                }).catch((e) => maxLog('bot_send_failed', { stage: 'start_expired', error: String(e?.message || e) }));
            }
            else {
                await (0, maxBotService_1.sendMaxInfoMessage)({
                    chatId,
                    text: 'Эта сессия подтверждения уже завершена.',
                }).catch((e) => maxLog('bot_send_failed', { stage: 'start_already_done', error: String(e?.message || e) }));
            }
        }
    }
    else if (fromIdRaw && isStartEvent) {
        const shouldSend = await shouldSendWelcomeOnce('max', String(fromIdRaw));
        if (shouldSend) {
            await (0, maxBotService_1.sendMaxWelcomeMessage)({
                chatId: String(targetChatId),
                startParam: 'home',
            }).catch((e) => maxLog('bot_send_failed', { stage: 'start_welcome', error: String(e?.message || e) }));
        }
    }
    if (!fromIdRaw || !parsed.phoneRaw)
        return;
    const normalized = (0, telegramAuthService_1.normalizePhoneE164)(String(parsed.phoneRaw));
    if (!normalized)
        return;
    await (0, maxAuthService_1.setMaxContactPhone)(String(fromIdRaw), normalized);
    const verification = await (0, phoneVerificationService_1.verifyPhoneByMaxContact)({
        maxUserId: String(fromIdRaw),
        phoneRaw: String(parsed.phoneRaw),
        username,
    });
    if (!verification.ok && verification.reason === 'SESSION_NOT_FOUND') {
        maxLog('contact_without_session', { maxUserId: String(fromIdRaw) });
        return;
    }
    if (targetChatId !== null && targetChatId !== undefined) {
        const chatId = String(targetChatId);
        if (verification.ok) {
            await (0, maxBotService_1.sendMaxInfoMessage)({
                chatId,
                text: 'Номер телефона подтверждён. Можно вернуться в приложение.',
            }).catch((e) => maxLog('bot_send_failed', { stage: 'verified', error: String(e?.message || e) }));
        }
        else if (verification.reason === 'PHONE_MISMATCH') {
            await (0, maxBotService_1.sendMaxInfoMessage)({
                chatId,
                text: 'Отправлен другой номер. Нажмите кнопку и отправьте контакт с нужным номером.',
            }).catch((e) => maxLog('bot_send_failed', { stage: 'phone_mismatch', error: String(e?.message || e) }));
        }
        else if (verification.reason === 'SESSION_NOT_FOUND' || verification.reason === 'SESSION_EXPIRED') {
            await (0, maxBotService_1.sendMaxInfoMessage)({
                chatId,
                text: 'Сессия подтверждения не найдена или истекла. Запустите подтверждение заново в приложении.',
            }).catch((e) => maxLog('bot_send_failed', { stage: 'session_not_found_or_expired', error: String(e?.message || e) }));
        }
        else if (verification.reason === 'PHONE_ALREADY_USED') {
            await (0, maxBotService_1.sendMaxInfoMessage)({
                chatId,
                text: 'Этот номер уже используется другим пользователем.',
            }).catch((e) => maxLog('bot_send_failed', { stage: 'phone_already_used', error: String(e?.message || e) }));
        }
        else if (verification.reason === 'MAX_ALREADY_USED') {
            await (0, maxBotService_1.sendMaxInfoMessage)({
                chatId,
                text: 'Этот MAX-аккаунт уже привязан к другому пользователю.',
            }).catch((e) => maxLog('bot_send_failed', { stage: 'max_already_used', error: String(e?.message || e) }));
        }
        else {
            await (0, maxBotService_1.sendMaxInfoMessage)({
                chatId,
                text: 'Не удалось подтвердить номер. Попробуйте снова из приложения.',
            }).catch((e) => maxLog('bot_send_failed', { stage: 'unknown_verification_error', error: String(e?.message || e) }));
        }
    }
}
(0, maxBotService_1.registerMaxUpdateHandler)(processMaxPhoneVerificationUpdate);
router.post('/max/webhook', async (req, res) => {
    try {
        if (MAX_WEBHOOK_SECRET) {
            const header = String(req.headers['x-max-bot-api-secret'] || '');
            if (!header || header !== MAX_WEBHOOK_SECRET) {
                return res.status(403).json((0, apiResponse_1.errorResponse)('Forbidden', apiResponse_1.ErrorCodes.FORBIDDEN));
            }
        }
        await processMaxPhoneVerificationUpdate(req.body || {});
        return res.json((0, apiResponse_1.successResponse)({ ok: true }));
    }
    catch (error) {
        return res.status(500).json((0, apiResponse_1.errorResponse)(error?.message || 'Webhook processing failed', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Вход пользователя
 *     description: Возвращает access и refresh токены, а также профиль пользователя.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *             required: [email, password]
 *     responses:
 *       200:
 *         description: Успешный вход
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверные учётные данные
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       403:
 *         description: Аккаунт не активирован/заблокирован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email и пароль', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
    }
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
        return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный формат email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
    }
    try {
        const user = (await client_1.default.user.findFirst({
            where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
            include: {
                role: {
                    include: {
                        permissions: { include: { permission: true } },
                    },
                },
                loginAttempts: {
                    orderBy: { createdAt: 'desc' },
                    take: 20,
                },
                clientProfile: true,
                supplierProfile: true,
                employeeProfile: true,
            },
        }));
        if (!user)
            return res.status(401).json((0, apiResponse_1.errorResponse)('Неверные учетные данные', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        if (user.profileStatus === 'BLOCKED') {
            return res.status(403).json((0, apiResponse_1.errorResponse)('Ваш аккаунт заблокирован. Обратитесь в поддержку.', apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        if (!user.isActive || user.profileStatus === 'PENDING') {
            return res.status(403).json((0, apiResponse_1.errorResponse)('Аккаунт не активирован. Пожалуйста, подтвердите email.', apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        if (!user.passwordHash) {
            return res.status(401).json((0, apiResponse_1.errorResponse)('Для этого аккаунта вход по паролю не настроен', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const validPassword = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!validPassword) {
            await client_1.default.loginAttempt.create({
                data: { userId: user.id, success: false, ip: req.ip },
            });
            const failedAttemptsCount = (user.loginAttempts ?? []).filter((a) => !a.success).length + 1;
            if (failedAttemptsCount >= MAX_FAILED_LOGIN_ATTEMPTS) {
                await client_1.default.user.update({
                    where: { id: user.id },
                    data: { profileStatus: 'BLOCKED' },
                });
                await client_1.default.auditLog.create({
                    data: {
                        userId: user.id,
                        action: 'OTHER',
                        targetType: 'USER',
                        targetId: user.id,
                        details: 'Автоматическая блокировка из-за множества неудачных попыток входа',
                    },
                });
                return res.status(403).json((0, apiResponse_1.errorResponse)('Слишком много неудачных попыток. Ваш аккаунт заблокирован.', apiResponse_1.ErrorCodes.FORBIDDEN));
            }
            return res.status(401).json((0, apiResponse_1.errorResponse)('Неверные учетные данные', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const profileType = user.currentProfileType;
        const hasAnyProfile = user.clientProfile !== null ||
            user.supplierProfile !== null ||
            user.employeeProfile !== null;
        let activeProfile = null;
        if (profileType === 'CLIENT')
            activeProfile = user.clientProfile;
        else if (profileType === 'SUPPLIER')
            activeProfile = user.supplierProfile;
        else if (profileType === 'EMPLOYEE')
            activeProfile = user.employeeProfile;
        const accessToken = generateAccessToken(user);
        // Создаём refresh токен и сохраняем сразу
        const refreshToken = await createUniqueRefreshToken(user.id);
        await client_1.default.loginAttempt.create({
            data: { userId: user.id, success: true, ip: req.ip },
        });
        await client_1.default.auditLog.create({
            data: {
                userId: user.id,
                action: 'LOGIN',
                targetType: 'USER',
                targetId: user.id,
                details: 'Успешный вход в систему',
            },
        });
        const profileResponse = hasAnyProfile
            ? {
                clientProfile: user.clientProfile,
                supplierProfile: user.supplierProfile,
                employeeProfile: user.employeeProfile,
                currentProfileType: profileType ?? null,
                profileData: activeProfile ?? null,
            }
            : null;
        const resProfile = await (0, userService_1.getProfile)(user.id);
        res.json((0, apiResponse_1.successResponse)({
            accessToken,
            refreshToken,
            profile: resProfile,
            message: "Вход успешный"
        }));
    }
    catch (error) {
        console.error('Ошибка при входе:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка входа', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
/**
 * @openapi
 * /auth/token:
 *   post:
 *     tags: [Auth]
 *     summary: Обновление пары токенов по refresh токену
 *     description: Принимает действительный refresh токен, отзывает его и выдаёт новую пару access/refresh.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken: { type: string }
 *             required: [refreshToken]
 *     responses:
 *       200:
 *         description: Новые токены выданы
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Не передан refresh токен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       403:
 *         description: Неверный/просроченный/отозванный refresh токен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/token', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
        return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется refresh токен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
    }
    console.log('Получен refreshToken:', refreshToken);
    try {
        const storedToken = await client_1.default.refreshToken.findUnique({
            where: { token: refreshToken },
        });
        if (!storedToken) {
            console.error('Refresh токен не найден в БД');
            return res.status(403).json((0, apiResponse_1.errorResponse)('Неверный refresh токен', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        if (storedToken.revoked || storedToken.expiresAt < new Date()) {
            console.error('Refresh токен отозван или просрочен');
            return res.status(403).json((0, apiResponse_1.errorResponse)('Неверный или просроченный refresh токен', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        jsonwebtoken_1.default.verify(refreshToken, refreshTokenSecret, async (err, payload) => {
            if (err || !payload?.userId) {
                console.error('Неверный refresh токен:', err?.message || 'payload.userId отсутствует');
                return res.status(403).json((0, apiResponse_1.errorResponse)('Неверный refresh токен', apiResponse_1.ErrorCodes.UNAUTHORIZED));
            }
            const user = await client_1.default.user.findUnique({
                where: { id: payload.userId },
                include: {
                    role: {
                        include: {
                            permissions: {
                                include: { permission: true },
                            },
                        },
                    },
                },
            });
            if (!user) {
                console.error('Пользователь не найден');
                return res.status(403).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.UNAUTHORIZED));
            }
            const userWithRole = user;
            const newAccessToken = generateAccessToken(userWithRole);
            try {
                // Отзываем старый токен и создаём новый
                await client_1.default.$transaction(async (tx) => {
                    await tx.refreshToken.update({
                        where: { id: storedToken.id },
                        data: { revoked: true },
                    });
                    await createUniqueRefreshToken(user.id); // важное: сюда передаём ID
                });
                // Получаем только что созданный токен
                const newRefreshToken = await client_1.default.refreshToken.findFirst({
                    where: { userId: user.id, revoked: false },
                    orderBy: { createdAt: 'desc' },
                });
                if (!newRefreshToken) {
                    throw new Error('Не удалось получить новый refresh токен после создания');
                }
                const profile = await (0, userService_1.getProfile)(user.id);
                res.json((0, apiResponse_1.successResponse)({
                    accessToken: newAccessToken,
                    refreshToken: newRefreshToken.token,
                    profile
                }));
            }
            catch (e) {
                console.error('Ошибка создания нового refresh токена:', e);
                res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления токенов', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
            }
        });
    }
    catch (error) {
        console.error('Ошибка при обновлении токена:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Обновление токена не удалось', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Выход и отзыв refresh токена
 *     description: Требуется bearer JWT. Отзывает указанный refresh токен пользователя.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken: { type: string }
 *             required: [refreshToken]
 *     responses:
 *       200:
 *         description: Успешный выход
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Не передан refresh токен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/logout', auth_1.authenticateToken, async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken)
        return res.status(400).json((0, apiResponse_1.errorResponse)('Refresh token required', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
    try {
        await client_1.default.refreshToken.updateMany({
            where: { token: refreshToken, userId: req.user.userId },
            data: { revoked: true },
        });
        res.json((0, apiResponse_1.successResponse)({ message: 'Logged out successfully' }));
    }
    catch (error) {
        console.error('Ошибка logout:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Logout failed', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
/**
 * @openapi
 * /auth/verify:
 *   post:
 *     tags: [Auth]
 *     summary: Подтверждение аккаунта кодом из email
 *     description: Активирует учётную запись и возвращает пару access/refresh токенов.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               code: { type: string }
 *             required: [email, code]
 *     responses:
 *       200:
 *         description: Успешное подтверждение и вход
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Неверный/просроченный код или уже активирован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       404:
 *         description: Пользователь не найден
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       429:
 *         description: Превышено число попыток подтверждения
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email и код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const normalizedEmail = normalizeEmail(email);
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный формат email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const trimmedCode = String(code).trim();
        if (!trimmedCode) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется код подтверждения', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const user = await client_1.default.user.findUnique({ where: { email: normalizedEmail } });
        if (!user)
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        if (user.isActive)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Аккаунт уже активирован', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const latestVerification = await client_1.default.emailVerification.findFirst({
            where: { userId: user.id, used: false },
            orderBy: { createdAt: 'desc' },
        });
        if (!latestVerification) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Код подтверждения не найден. Запросите новый код.', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const now = new Date();
        if (latestVerification.expiresAt <= now) {
            await client_1.default.emailVerification.update({
                where: { id: latestVerification.id },
                data: { used: true },
            });
            return res.status(400).json((0, apiResponse_1.errorResponse)('Код подтверждения просрочен. Запросите новый код.', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (latestVerification.code !== trimmedCode) {
            const newAttempts = (latestVerification.attemptsCount || 0) + 1;
            const tooMany = newAttempts >= MAX_VERIFICATION_ATTEMPTS;
            await client_1.default.emailVerification.update({
                where: { id: latestVerification.id },
                data: {
                    attemptsCount: newAttempts,
                    ...(tooMany ? { used: true } : {}),
                },
            });
            if (tooMany) {
                return res.status(429).json((0, apiResponse_1.errorResponse)('Превышено максимальное количество попыток подтверждения', apiResponse_1.ErrorCodes.TOO_MANY_REQUESTS));
            }
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный код подтверждения', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        await client_1.default.emailVerification.update({
            where: { id: latestVerification.id },
            data: { used: true },
        });
        await client_1.default.user.update({
            where: { id: user.id },
            data: {
                isActive: true,
                profileStatus: 'ACTIVE',
            },
        });
        const userWithRole = await client_1.default.user.findUnique({
            where: { id: user.id },
            include: {
                role: {
                    include: {
                        permissions: {
                            include: { permission: true }
                        }
                    }
                },
                clientProfile: true,
                supplierProfile: true,
                employeeProfile: true
            },
        });
        if (!userWithRole) {
            console.error('Ошибка получения данных пользователя после верификации');
            return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения данных пользователя', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
        }
        const accessToken = generateAccessToken(userWithRole);
        const refreshToken = await createUniqueRefreshToken(userWithRole.id);
        const profile = await (0, userService_1.getProfile)(userWithRole.id);
        res.json((0, apiResponse_1.successResponse)({
            accessToken,
            refreshToken,
            profile,
            message: 'Аккаунт подтвержден и активирован'
        }));
    }
    catch (error) {
        console.error('Ошибка подтверждения:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка подтверждения', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
exports.default = router;
