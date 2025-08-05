"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkUserStatus = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const checkUserStatus = async (req, res, next) => {
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
        if (user.profileStatus === client_1.ProfileStatus.BLOCKED) {
            return res.status(403).json({ message: 'Доступ запрещен: учетная запись заблокирована' });
        }
        next();
    }
    catch (error) {
        return res.status(500).json({ message: 'Ошибка проверки статуса пользователя', error });
    }
};
exports.checkUserStatus = checkUserStatus;
