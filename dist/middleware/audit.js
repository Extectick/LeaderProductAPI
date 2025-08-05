"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLog = auditLog;
exports.authorizeDepartmentManager = authorizeDepartmentManager;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
// Middleware для логирования действий пользователя
function auditLog(action, targetType, targetId) {
    return async (req, res, next) => {
        try {
            const userId = req.userId || req.user?.userId || null;
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
                    action: actionEnum,
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
        }
        catch (error) {
            console.error('Audit log error:', error);
            // Не блокируем основной поток из-за ошибки логирования
        }
        next();
    };
}
// Middleware для проверки, что пользователь является начальником отдела
async function authorizeDepartmentManager(req, res, next) {
    const userId = req.user?.userId;
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
    }
    catch (error) {
        res.status(500).json({ message: 'Authorization check failed', error });
    }
}
