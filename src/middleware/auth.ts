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

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];

  // console.log('Authorization header:', authHeader);

  if (!authHeader) {
    return res.status(401).json({ message: 'Требуется токен авторизации' });
  }

  const parts = authHeader.split(' ');

  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ message: 'Неверный формат токена авторизации' });
  }

  const token = parts[1];

  // console.log('Extracted token:', token);

  jwt.verify(token, accessTokenSecret, (err: any, user: any) => {
    if (err) {
      console.error('JWT verification error:', err);
      return res.status(403).json({ message: 'Ошибка в токене авторизации или он истек' });
    }
    req.user = user as JwtPayload;
    next();
  });
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
