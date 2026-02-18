import prisma from '../prisma/client';
import { sendPushToUser } from './pushService';
import { sendTelegramInfoMessage } from './telegramBotService';
import { sendMaxInfoMessage } from './maxBotService';

export type EmployeeModerationAction = 'APPROVE' | 'REJECT';

export type ProfileModerationNotificationResult = {
  pushSent: boolean;
  telegramSent: boolean;
  maxSent: boolean;
  skipped: string[];
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildTexts(action: EmployeeModerationAction, reason?: string | null): { title: string; body: string; botText: string } {
  if (action === 'APPROVE') {
    const title = 'Профиль подтверждён';
    const body = 'Ваш профиль сотрудника подтверждён. Доступ сотрудника активирован.';
    const botText = `<b>${title}</b>\nВаш профиль сотрудника подтверждён. Доступ сотрудника активирован.`;
    return { title, body, botText };
  }

  const safeReason = String(reason || '').trim();
  const reasonLine = safeReason ? `\nПричина: ${safeReason}` : '';
  const reasonLineHtml = safeReason ? `\nПричина: ${escapeHtml(safeReason)}` : '';
  const title = 'Профиль сотрудника отклонён';
  const body = `Профиль сотрудника отклонён администратором.${reasonLine}`;
  const botText = `<b>${title}</b>\nПрофиль сотрудника отклонён администратором.${reasonLineHtml}`;
  return { title, body, botText };
}

export async function notifyEmployeeModerationResult(params: {
  userId: number;
  action: EmployeeModerationAction;
  reason?: string | null;
}): Promise<ProfileModerationNotificationResult> {
  const { userId, action, reason } = params;
  const skipped: string[] = [];

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      telegramId: true,
      maxId: true,
      notificationSettings: {
        select: {
          inAppNotificationsEnabled: true,
          telegramNotificationsEnabled: true,
          maxNotificationsEnabled: true,
        },
      },
      _count: {
        select: {
          deviceTokens: true,
        },
      },
    },
  });

  if (!user) {
    return { pushSent: false, telegramSent: false, maxSent: false, skipped: ['user_not_found'] };
  }

  const inAppEnabled = user.notificationSettings?.inAppNotificationsEnabled ?? true;
  const telegramEnabled = user.notificationSettings?.telegramNotificationsEnabled ?? true;
  const maxEnabled = user.notificationSettings?.maxNotificationsEnabled ?? true;

  const texts = buildTexts(action, reason);

  let pushSent = false;
  if (!inAppEnabled) {
    skipped.push('push_disabled');
  } else if ((user._count?.deviceTokens || 0) <= 0) {
    skipped.push('push_no_tokens');
  } else {
    const pushResult = await sendPushToUser(userId, {
      title: texts.title,
      body: texts.body,
      data: { type: 'EMPLOYEE_MODERATION', action, status: action === 'APPROVE' ? 'ACTIVE' : 'BLOCKED' },
      sound: 'default',
      channelId: 'profile-status',
    });
    pushSent = Boolean(pushResult?.ok);
    if (!pushSent) skipped.push(`push_${String(pushResult?.reason || 'send_failed')}`);
  }

  let telegramSent = false;
  if (!telegramEnabled) {
    skipped.push('telegram_disabled');
  } else if (!user.telegramId) {
    skipped.push('telegram_not_linked');
  } else {
    telegramSent = await sendTelegramInfoMessage({
      chatId: user.telegramId,
      text: texts.botText,
      parseMode: 'HTML',
      disableLinkPreview: true,
    });
    if (!telegramSent) skipped.push('telegram_send_failed');
  }

  let maxSent = false;
  if (!maxEnabled) {
    skipped.push('max_disabled');
  } else if (!user.maxId) {
    skipped.push('max_not_linked');
  } else {
    maxSent = await sendMaxInfoMessage({
      chatId: user.maxId,
      text: texts.botText,
      parseMode: 'HTML',
      disableLinkPreview: true,
    });
    if (!maxSent) skipped.push('max_send_failed');
  }

  return { pushSent, telegramSent, maxSent, skipped };
}
