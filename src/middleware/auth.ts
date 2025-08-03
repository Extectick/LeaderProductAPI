import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

import { ProfileStatus } from '@prisma/client';

interface JwtPayload {
  userId: number;
  role: string;
  permissions: string[];
  profileStatus: ProfileStatus;
  iat: number;
  exp: number;
}

export interface AuthRequest<P = {}, ResBody = {}, ReqBody = {}, ReqQuery = {}>
  extends Request<P, ResBody, ReqBody, ReqQuery> {
  user?: JwtPayload;
}

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
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
    const decoded = jwt.verify(token, accessTokenSecret) as JwtPayload;

    if (!decoded?.userId || !decoded?.role) {
      return res.status(401).json({ message: 'Неверный payload токена', code: 'INVALID_PAYLOAD' });
    }

    req.user = decoded;
    next();
  } catch (err: any) {
    const isExpired = err?.name === 'TokenExpiredError';

    return res.status(401).json({
      message: isExpired ? 'Токен просрочен' : 'Недействительный токен',
      code: isExpired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
}


async function getRoleHierarchy(roleName: string, prisma: any, rolesSet = new Set<string>()): Promise<Set<string>> {
  if (rolesSet.has(roleName)) return rolesSet;
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

export function authorizeRoles(allowedRoles: string[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ message: 'Не авторизован' });

    const prisma = new (await import('@prisma/client')).PrismaClient();

    try {
      const userRoles = await getRoleHierarchy(req.user.role, prisma);
      const hasRole = allowedRoles.some(role => userRoles.has(role));
      if (!hasRole) {
        return res.status(403).json({ message: 'Ошибка: не достаточно прав' });
      }
      next();
    } catch (error) {
      return res.status(500).json({ message: 'Ошибка при авторизации', error });
    } finally {
      await prisma.$disconnect();
    }
  };
}

export function authorizePermissions(requiredPermissions: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ message: 'Не авторизован' });
    const hasPermission = requiredPermissions.every(p => req.user!.permissions.includes(p));
    if (!hasPermission) {
      return res.status(403).json({ message: 'Ошибка: не достаточно прав' });
    }
    next();
  };
}
