import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface AuditRequest extends Request {
  userId?: number;
}

// Middleware для логирования действий пользователя
export function auditLog(action: string, targetType?: string, targetId?: number) {
  return async (req: AuditRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId || (req as any).user?.userId || null;

      // Преобразуем action в enum ActionType, если возможно
      const actionEnum = (() => {
        const upperAction = action.toUpperCase();
        const validActions = [
          'CREATE',
          'UPDATE',
          'DELETE',
          'LOGIN',
          'LOGOUT',
          'PASSWORD_RESET',
          'EMAIL_VERIFICATION',
          'OTHER',
        ];
        return validActions.includes(upperAction) ? upperAction : 'OTHER';
      })();

      await prisma.auditLog.create({
        data: {
          userId,
          action: actionEnum as any,
          targetType,
          targetId,
          details: JSON.stringify({
            method: req.method,
            path: req.path,
            body: req.body,
            params: req.params,
            query: req.query,
          }),
        },
      });
    } catch (error) {
      console.error('Audit log error:', error);
      // Не блокируем основной поток из-за ошибки логирования
    }
    next();
  };
}

// Middleware для проверки, что пользователь является начальником отдела
export async function authorizeDepartmentManager(req: Request, res: Response, next: NextFunction) {
  const userId = (req as any).user?.userId;
  const departmentId = Number(req.params.departmentId) || Number(req.body.departmentId);

  if (!userId || !departmentId) {
    return res.status(400).json({ message: 'User ID and Department ID are required' });
  }

  try {
    const isManager = await prisma.departmentRole.findFirst({
      where: {
        userId,
        departmentId,
        role: {
          name: 'department_manager',
        },
      },
    });

    if (!isManager) {
      return res.status(403).json({ message: 'Forbidden: not a department manager' });
    }

    next();
  } catch (error) {
    res.status(500).json({ message: 'Authorization check failed', error });
  }
}
