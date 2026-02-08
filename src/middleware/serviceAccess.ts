import { NextFunction, Response } from 'express';
import { AuthRequest } from './auth';
import { ErrorCodes, errorResponse } from '../utils/apiResponse';
import { resolveServiceAccessForUser } from '../services/serviceAccess';

export function authorizeServiceAccess(serviceKey: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user?.userId) {
        return res
          .status(401)
          .json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const access = await resolveServiceAccessForUser(req.user.userId, serviceKey);
      if (!access) {
        return res
          .status(404)
          .json(errorResponse('Сервис не найден', ErrorCodes.NOT_FOUND));
      }

      if (!access.isEmployee) {
        return res
          .status(403)
          .json(errorResponse('Сервисы доступны только сотрудникам', ErrorCodes.FORBIDDEN));
      }

      if (!access.visible || !access.enabled) {
        return res
          .status(403)
          .json(errorResponse('Доступ к сервису запрещён', ErrorCodes.FORBIDDEN));
      }

      return next();
    } catch (error) {
      console.error('authorizeServiceAccess error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка проверки доступа к сервису', ErrorCodes.INTERNAL_ERROR));
    }
  };
}
