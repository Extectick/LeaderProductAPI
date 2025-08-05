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
exports.authenticateToken = authenticateToken;
exports.authorizeRoles = authorizeRoles;
exports.authorizePermissions = authorizePermissions;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ message: 'Требуется токен авторизации', code: 'NO_TOKEN' });
    }
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({ message: 'Неверный формат токена', code: 'BAD_AUTH_FORMAT' });
    }
    const token = parts[1].trim();
    if (!token) {
        return res.status(401).json({ message: 'Токен отсутствует', code: 'EMPTY_TOKEN' });
    }
    // Проверка символов (только ASCII)
    if (!/^[\x00-\x7F]*$/.test(token)) {
        return res.status(401).json({ message: 'Недопустимые символы в токене', code: 'INVALID_CHARS' });
    }
    // Структура JWT: base64.base64.base64
    if (!/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]*$/.test(token)) {
        return res.status(401).json({ message: 'Неверная структура токена', code: 'INVALID_STRUCTURE' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, accessTokenSecret);
        if (!decoded?.userId || !decoded?.role) {
            return res.status(401).json({ message: 'Неверный payload токена', code: 'INVALID_PAYLOAD' });
        }
        req.user = decoded;
        next();
    }
    catch (err) {
        const isExpired = err?.name === 'TokenExpiredError';
        return res.status(401).json({
            message: isExpired ? 'Токен просрочен' : 'Недействительный токен',
            code: isExpired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined,
        });
    }
}
async function getRoleHierarchy(roleName, prisma, rolesSet = new Set()) {
    if (rolesSet.has(roleName))
        return rolesSet;
    rolesSet.add(roleName);
    const role = await prisma.role.findUnique({
        where: { name: roleName },
        include: { parentRole: true },
    });
    if (role && role.parentRole) {
        await getRoleHierarchy(role.parentRole.name, prisma, rolesSet);
    }
    return rolesSet;
}
function authorizeRoles(allowedRoles) {
    return async (req, res, next) => {
        if (!req.user)
            return res.status(401).json({ message: 'Не авторизован' });
        const prisma = new (await Promise.resolve().then(() => __importStar(require('@prisma/client')))).PrismaClient();
        try {
            const userRoles = await getRoleHierarchy(req.user.role, prisma);
            const hasRole = allowedRoles.some(role => userRoles.has(role));
            if (!hasRole) {
                return res.status(403).json({ message: 'Ошибка: не достаточно прав' });
            }
            next();
        }
        catch (error) {
            return res.status(500).json({ message: 'Ошибка при авторизации', error });
        }
        finally {
            await prisma.$disconnect();
        }
    };
}
function authorizePermissions(requiredPermissions) {
    return (req, res, next) => {
        if (!req.user)
            return res.status(401).json({ message: 'Не авторизован' });
        const hasPermission = requiredPermissions.every(p => req.user.permissions.includes(p));
        if (!hasPermission) {
            return res.status(403).json({ message: 'Ошибка: не достаточно прав' });
        }
        next();
    };
}
