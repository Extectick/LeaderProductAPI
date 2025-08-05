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
const client_1 = require("@prisma/client");
const auth_1 = require("../middleware/auth");
const mailService_1 = require("../services/mailService");
const passwordReset_1 = __importDefault(require("./passwordReset"));
const crypto_1 = __importStar(require("crypto"));
const apiResponse_1 = require("../utils/apiResponse");
const userService_1 = require("../services/userService");
const router = express_1.default.Router();
router.use(passwordReset_1.default);
const prisma = new client_1.PrismaClient();
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET || 'yourrefreshtokensecret';
const accessTokenLife = '15m';
const refreshTokenLife = '14d';
const MAX_FAILED_LOGIN_ATTEMPTS = 19;
const MAX_VERIFICATION_ATTEMPTS = 5;
const RESEND_CODE_INTERVAL_MS = 25 * 1000; // 25 секунд
const VERIFICATION_CODE_EXPIRATION_MS = 60 * 60 * 1000; // 1 час
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
    const existingVerification = await prisma.emailVerification.findFirst({
        where: { userId, used: false },
        orderBy: { createdAt: 'desc' },
    });
    if (existingVerification) {
        const now = new Date();
        if (existingVerification.lastSentAt &&
            now.getTime() - existingVerification.lastSentAt.getTime() < RESEND_CODE_INTERVAL_MS) {
            throw new Error('Verification code was sent recently. Please wait before requesting a new code.');
        }
        await prisma.emailVerification.update({
            where: { id: existingVerification.id },
            data: { lastSentAt: new Date() },
        });
        await (0, mailService_1.sendVerificationEmail)(email, existingVerification.code);
        return;
    }
    const code = generateVerificationCode();
    await prisma.emailVerification.create({
        data: {
            userId,
            code,
            expiresAt: new Date(Date.now() + VERIFICATION_CODE_EXPIRATION_MS),
            used: false,
            attemptsCount: 0,
            lastSentAt: new Date(),
        },
    });
    await (0, mailService_1.sendVerificationEmail)(email, code);
}
function generateSecureRandomToken(length = 64) {
    return crypto_1.default.randomBytes(length).toString('hex'); // 128-символьный строковый токен
}
// Функция создания уникального refresh токена с повтором при коллизии
async function createUniqueRefreshToken(userId) {
    const jti = (0, crypto_1.randomUUID)(); // Гарантирует уникальность
    const token = jsonwebtoken_1.default.sign({ userId, jti }, refreshTokenSecret, { expiresIn: '30d' });
    await prisma.refreshToken.create({
        data: {
            token,
            userId,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
    });
    return token;
}
router.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email и пароль', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email))
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный формат email', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        if (password.length < 6)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Пароль должен быть не менее 6 символов', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            if (!existingUser.isActive) {
                await sendVerificationCodeEmail(existingUser.id, email);
                return res.status(200).json((0, apiResponse_1.successResponse)(null, 'Пользователь уже зарегистрирован, но не активирован. Код подтверждения отправлен повторно.'));
            }
            return res.status(409).json((0, apiResponse_1.errorResponse)('Пользователь уже существует', apiResponse_1.ErrorCodes.CONFLICT));
        }
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                email,
                passwordHash,
                isActive: false,
                role: { connect: { name: 'user' } },
            },
        });
        await sendVerificationCodeEmail(user.id, email);
        res.status(201).json((0, apiResponse_1.successResponse)(null, 'Пользователь зарегистрирован. Пожалуйста, подтвердите email.'));
    }
    catch (error) {
        if (error.message && error.message.includes('recently')) {
            return res.status(429).json((0, apiResponse_1.errorResponse)(error.message, apiResponse_1.ErrorCodes.TOO_MANY_REQUESTS));
        }
        console.error('Ошибка регистрации:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка регистрации', apiResponse_1.ErrorCodes.INTERNAL_ERROR, process.env.NODE_ENV === 'development' ? error : undefined));
    }
});
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email и пароль', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
    try {
        const user = (await prisma.user.findUnique({
            where: { email },
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
        const validPassword = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!validPassword) {
            await prisma.loginAttempt.create({
                data: { userId: user.id, success: false, ip: req.ip },
            });
            const failedAttemptsCount = (user.loginAttempts ?? []).filter((a) => !a.success).length;
            if (failedAttemptsCount >= MAX_FAILED_LOGIN_ATTEMPTS) {
                await prisma.user.update({
                    where: { id: user.id },
                    data: { profileStatus: 'BLOCKED' },
                });
                await prisma.auditLog.create({
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
        if (activeProfile?.status === 'BLOCKED') {
            return res.status(403).json((0, apiResponse_1.errorResponse)('Слишком много неудачных попыток. Ваш аккаунт заблокирован.', apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        const accessToken = generateAccessToken(user);
        // Создаём refresh токен и сохраняем сразу
        const refreshToken = await createUniqueRefreshToken(user.id);
        await prisma.loginAttempt.create({
            data: { userId: user.id, success: true, ip: req.ip },
        });
        await prisma.auditLog.create({
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
router.post('/token', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
        return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется refresh токен', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
    }
    console.log('Получен refreshToken:', refreshToken);
    try {
        const storedToken = await prisma.refreshToken.findUnique({
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
            const user = await prisma.user.findUnique({
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
                await prisma.$transaction(async (tx) => {
                    await tx.refreshToken.update({
                        where: { id: storedToken.id },
                        data: { revoked: true },
                    });
                    await createUniqueRefreshToken(user.id); // важное: сюда передаём ID
                });
                // Получаем только что созданный токен
                const newRefreshToken = await prisma.refreshToken.findFirst({
                    where: { userId: user.id, revoked: false },
                    orderBy: { createdAt: 'desc' },
                });
                if (!newRefreshToken) {
                    throw new Error('Не удалось получить новый refresh токен после создания');
                }
                res.json((0, apiResponse_1.successResponse)({
                    accessToken: newAccessToken,
                    refreshToken: newRefreshToken.token
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
router.post('/logout', auth_1.authenticateToken, async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken)
        return res.status(400).json((0, apiResponse_1.errorResponse)('Refresh token required', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
    try {
        await prisma.refreshToken.updateMany({
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
router.post('/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Требуется email и код', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user)
            return res.status(404).json((0, apiResponse_1.errorResponse)('Пользователь не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        if (user.isActive)
            return res.status(400).json((0, apiResponse_1.errorResponse)('Аккаунт уже активирован', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        const verification = await prisma.emailVerification.findFirst({
            where: { userId: user.id, code, used: false, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
        });
        if (!verification) {
            const lastVerification = await prisma.emailVerification.findFirst({
                where: { userId: user.id, used: false },
                orderBy: { createdAt: 'desc' },
            });
            if (lastVerification) {
                const newAttempts = (lastVerification.attemptsCount || 0) + 1;
                if (newAttempts >= MAX_VERIFICATION_ATTEMPTS) {
                    return res.status(429).json((0, apiResponse_1.errorResponse)('Превышено максимальное количество попыток подтверждения', apiResponse_1.ErrorCodes.TOO_MANY_REQUESTS));
                }
                await prisma.emailVerification.update({
                    where: { id: lastVerification.id },
                    data: { attemptsCount: newAttempts },
                });
            }
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный или просроченный код подтверждения', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        await prisma.emailVerification.update({
            where: { id: verification.id },
            data: { used: true },
        });
        await prisma.user.update({
            where: { id: user.id },
            data: {
                isActive: true,
                profileStatus: 'ACTIVE',
            },
        });
        const userWithRole = await prisma.user.findUnique({
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
        res.json((0, apiResponse_1.successResponse)({
            accessToken,
            refreshToken,
            message: 'Аккаунт подтвержден и активирован'
        }));
    }
    catch (error) {
        console.error('Ошибка подтверждения:', error);
        res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка подтверждения', apiResponse_1.ErrorCodes.INTERNAL_ERROR));
    }
});
exports.default = router;
