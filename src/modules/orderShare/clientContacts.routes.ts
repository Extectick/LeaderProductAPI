import express from 'express';
import prisma from '../../prisma/client';
import { authenticateToken, authorizePermissions, type AuthRequest } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import { clientContactsSchema, resolveClientContacts } from './clientContacts';

const router = express.Router();

function handler(admin: boolean, write: boolean): express.RequestHandler {
  return async (req: AuthRequest, res) => {
    const id = admin ? Number((req.params as Record<string, string>).userId) : req.user!.userId;
    if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ ok: false, message: 'Некорректный пользователь' }); return; }
    try {
      const user = await prisma.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, phone: true, clientContacts: true } });
      if (!user) { res.status(404).json({ ok: false, message: 'Пользователь не найден' }); return; }
      let settings = user.clientContacts;
      if (write) {
        const parsed = clientContactsSchema.safeParse(req.body);
        if (!parsed.success) { res.status(400).json({ ok: false, message: parsed.error.issues[0]?.message || 'Проверьте контакты' }); return; }
        settings = parsed.data;
        await prisma.$transaction([
          prisma.user.update({ where: { id }, data: { clientContacts: parsed.data } }),
          prisma.auditLog.create({ data: { userId: req.user!.userId, action: 'UPDATE', targetType: 'ClientContacts', targetId: id,
            details: JSON.stringify({ byAdmin: admin, phoneCount: parsed.data.phones.length, telegram: !!parsed.data.telegramUrl, max: !!parsed.data.maxUrl }) } }),
        ]);
      }
      const parsed = clientContactsSchema.safeParse(settings);
      res.set('Cache-Control', 'no-store').json({ ok: true, data: {
        settings: parsed.success ? parsed.data : { phones: [], telegramUrl: null, maxUrl: null },
        defaultPhone: user.phone == null ? null : `+${user.phone.toString()}`,
        effective: resolveClientContacts(settings, user.phone),
      } });
    } catch { res.status(500).json({ ok: false, message: 'Не удалось сохранить или загрузить контакты' }); }
  };
}
router.get('/me/client-contacts', authenticateToken, checkUserStatus, handler(false, false));
router.put('/me/client-contacts', authenticateToken, checkUserStatus, handler(false, true));
router.get('/:userId/client-contacts', authenticateToken, checkUserStatus, authorizePermissions(['manage_users']), handler(true, false));
router.put('/:userId/client-contacts', authenticateToken, checkUserStatus, authorizePermissions(['manage_users']), handler(true, true));
export default router;
