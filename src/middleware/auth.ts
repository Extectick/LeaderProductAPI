import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ProfileStatus } from '@prisma/client';
import prisma from '../prisma/client';

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

const accessTokenSecret =
  process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';

// единый инстанс Prisma
export const authPrisma = prisma;

/**
 * Аутентификация по JWT (Bearer)
 */
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

/**
 * Собирает все названия ролей с учётом иерархии (по имени роли).
 */
async function getRoleHierarchyByName(roleName: string): Promise<Set<string>> {
  const names = new Set<string>();
  let current: string | null = roleName;

  while (current) {
    if (names.has(current)) break;
    names.add(current);

    // ЯВНАЯ типизация результата findUnique => нет TS7022
    const res: { parentRole: { name: string } | null } | null =
      await authPrisma.role.findUnique({
        where: { name: current },
        select: { parentRole: { select: { name: true } } },
      });

    current = res?.parentRole?.name ?? null;
  }

  return names;
}

/**
 * Авторизация по ролям (учитывает иерархию parentRole)
 */
export function authorizeRoles(allowedRoles: string[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ message: 'Не авторизован' });

    try {
      const userRoles = await getRoleHierarchyByName(req.user.role);
      const hasRole = allowedRoles.some((role) => userRoles.has(role));
      if (!hasRole) {
        return res.status(403).json({ message: 'Ошибка: не достаточно прав' });
      }
      next();
    } catch (error) {
      return res.status(500).json({ message: 'Ошибка при авторизации', error });
    }
  };
}

/**
 * Собирает цепочку родительских ролей, включая исходную роль, по id.
 * Возвращает Set со всеми id ролей.
 */
async function collectRoleChain(roleId?: number | null): Promise<Set<number>> {
  const ids = new Set<number>();
  let current: number | null = roleId ?? null;

  while (current) {
    if (ids.has(current)) break; // защита от циклов
    ids.add(current);
    const next = await authPrisma.role.findUnique({
      where: { id: current },
      select: { parentRoleId: true },
    });
    current = next?.parentRoleId ?? null;
  }

  return ids;
}

/**
 * Рассчитывает полный набор прав пользователя из:
 * - базовой роли user.role (+ вся иерархия parentRoleId),
 * - всех ролей из DepartmentRole (+ их иерархии).
 */
async function computeUserPermissions(userId: number): Promise<Set<string>> {
  const user = await authPrisma.user.findUnique({
    where: { id: userId },
    select: {
      roleId: true,
      departmentRoles: {
        select: { roleId: true },
      },
    },
  });

  if (!user) return new Set<string>();

  // стартовые роли: глобальная + роли по отделам
  const seedRoleIds = new Set<number>([
    ...(user.roleId ? [user.roleId] : []),
    ...user.departmentRoles.map((dr: { roleId: number }) => dr.roleId),
  ]);

  // разворачиваем иерархии
  const allRoleIds = new Set<number>();
  for (const rid of seedRoleIds) {
    const chain = await collectRoleChain(rid);
    chain.forEach((id) => allRoleIds.add(id));
  }

  if (allRoleIds.size === 0) return new Set<string>();

  // забираем права по всем ролям
  const rolePerms = await authPrisma.rolePermissions.findMany({
    where: { roleId: { in: Array.from(allRoleIds) } },
    include: { permission: { select: { name: true } } },
  });

  const permSet = new Set<string>(
    rolePerms.map((rp: { permission: { name: string } }) => rp.permission.name)
  );

  return permSet;
}

/**
 * Проверка прав с учётом ролей пользователя, DepartmentRole и иерархии ролей.
 * @param requiredPermissions список требуемых прав
 * @param options.mode 'all' — нужны все права (по умолчанию), 'any' — достаточно одного из списка
 */
export function authorizePermissions(
  requiredPermissions: string[],
  options: { mode?: 'all' | 'any' } = {}
) {
  const mode = options.mode ?? 'all';

  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: 'Не авторизован' });
      }

      // Админские роли пропускаем без дополнительной проверки прав
      const roleChain = await getRoleHierarchyByName(req.user.role);
      if (roleChain.has('admin') || roleChain.has('administrator')) {
        return next();
      }

      // считаем полный набор прав пользователя из БД
      const permSet = await computeUserPermissions(req.user.userId);

      // положим в req.user.permissions для повторного использования
      req.user.permissions = Array.from(permSet);

      const hasPermission =
        mode === 'any'
          ? requiredPermissions.some((p) => permSet.has(p))
          : requiredPermissions.every((p) => permSet.has(p));

      if (!hasPermission) {
        return res.status(403).json({ message: 'Ошибка: не достаточно прав' });
      }

      return next();
    } catch (err) {
      console.error('authorizePermissions error:', err);
      return res.status(500).json({ message: 'Ошибка проверки прав' });
    }
  };
}
