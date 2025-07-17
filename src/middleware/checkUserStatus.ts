import { AuthRequest } from './auth';
import { Response, NextFunction } from 'express';
import { PrismaClient, ProfileStatus } from '@prisma/client';

const prisma = new PrismaClient();

export const checkUserStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const userId = req.user?.userId;
  if (!userId) {
    return res.status(401).json({ message: 'Пользователь не авторизован' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { profileStatus: true },
    });

    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }

    if (user.profileStatus === ProfileStatus.BLOCKED) {
      return res.status(403).json({ message: 'Доступ запрещен: учетная запись заблокирована' });
    }

    next();
  } catch (error) {
    return res.status(500).json({ message: 'Ошибка проверки статуса пользователя', error });
  }
};
