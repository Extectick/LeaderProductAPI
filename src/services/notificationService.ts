import prisma from '../prisma/client';
import { sendPushToUser } from './pushService';
import { sendTelegramInfoMessage } from './telegramBotService';
import { getPresenceForUsers } from './presenceService';

// Локальные типы настроек (совпадают с Prisma-моделью UserNotificationSettings)
type NotificationSettingsRow = {
  userId: number;
  inAppNotificationsEnabled: boolean;
  telegramNotificationsEnabled: boolean;
  pushNewMessage: boolean;
  pushStatusChanged: boolean;
  pushDeadlineChanged: boolean;
  telegramNewAppeal: boolean;
  telegramStatusChanged: boolean;
  telegramDeadlineChanged: boolean;
  telegramUnreadReminder: boolean;
  telegramClosureReminder: boolean;
  telegramNewMessage: boolean;
};

type MuteRow = { userId: number };

export type AppealNotificationType =
  | 'NEW_APPEAL'
  | 'STATUS_CHANGED'
  | 'DEADLINE_CHANGED'
  | 'NEW_MESSAGE'
  | 'UNREAD_REMINDER'
  | 'CLOSURE_REMINDER';

export type NotificationChannel = 'push' | 'telegram';

export type NotificationPayload = {
  type: AppealNotificationType;
  appealId: number;
  appealNumber: number;
  /** Заголовок push-уведомления */
  title: string;
  /** Тело push-уведомления */
  body: string;
  /** HTML-текст для Telegram-бота */
  telegramText: string;
  /** Дополнительные данные для push (data payload) */
  pushData?: Record<string, any>;
  /** Каналы доставки */
  channels: NotificationChannel[];
  /** Список userId получателей */
  recipientUserIds: number[];
  /** userId отправителя (не получает уведомление о себе) */
  excludeSenderUserId?: number;
  /** Учитывать AppealMute (по умолчанию true) */
  respectMute?: boolean;
};

/**
 * Центральный диспетчер уведомлений.
 * Учитывает UserNotificationSettings, AppealMute, online-статус пользователей.
 */
export async function dispatchNotification(payload: NotificationPayload): Promise<void> {
  const {
    type,
    appealId,
    appealNumber,
    title,
    body,
    telegramText,
    pushData,
    channels,
    recipientUserIds,
    excludeSenderUserId,
    respectMute = true,
  } = payload;

  if (!recipientUserIds.length) return;

  const uniqIds = Array.from(
    new Set(recipientUserIds.filter((id) => id !== excludeSenderUserId))
  );
  if (!uniqIds.length) return;

  // 1. Загрузить настройки и муты за один запрос
  const [settingsRows, muteRows] = await Promise.all([
    (prisma as any).userNotificationSettings.findMany({
      where: { userId: { in: uniqIds } },
    }) as Promise<NotificationSettingsRow[]>,
    respectMute
      ? (prisma as any).appealMute.findMany({
          where: { appealId, userId: { in: uniqIds } },
          select: { userId: true },
        }) as Promise<MuteRow[]>
      : Promise.resolve([] as MuteRow[]),
  ]);

  const settingsMap = new Map<number, NotificationSettingsRow>(
    settingsRows.map((s: NotificationSettingsRow) => [s.userId, s])
  );
  const mutedSet = new Set<number>(muteRows.map((m: MuteRow) => m.userId));

  // 2. Разделить получателей по каналам
  const pushCandidates: number[] = [];
  const telegramCandidates: number[] = [];

  for (const userId of uniqIds) {
    if (mutedSet.has(userId)) continue;

    const s = settingsMap.get(userId);

    if (channels.includes('push')) {
      const globalOn = s ? s.inAppNotificationsEnabled : true;
      const typeOn = s ? resolveTypePush(type, s) : true;
      if (globalOn && typeOn) pushCandidates.push(userId);
    }

    if (channels.includes('telegram')) {
      const globalOn = s ? s.telegramNotificationsEnabled : true;
      const typeOn = s ? resolveTypeTelegram(type, s) : true;
      if (globalOn && typeOn) telegramCandidates.push(userId);
    }
  }

  // 3. Получить online-статус кандидатов и применить channel-правила:
  // - push: только offline
  // - telegram: для части типов suppress для online (в приложении используем in-app/sockets)
  const onlineSet = await getOnlineUsersSet(Array.from(new Set([...pushCandidates, ...telegramCandidates])));
  const finalPushIds = pushCandidates.filter((id) => !onlineSet.has(id));
  const suppressTelegramForOnline = shouldSuppressTelegramForOnline(type);
  const finalTelegramIds = suppressTelegramForOnline
    ? telegramCandidates.filter((id) => !onlineSet.has(id))
    : telegramCandidates;
  if (suppressTelegramForOnline && telegramCandidates.length && !finalTelegramIds.length) {
    console.log(
      `[notifications] telegram skipped for type=${type}, all recipients are online (appealId=${appealId})`
    );
  }

  // 4. Загрузить telegramId для кандидатов Telegram
  let telegramUsers: { id: number; telegramId: bigint | null }[] = [];
  if (finalTelegramIds.length) {
    telegramUsers = await prisma.user.findMany({
      where: { id: { in: finalTelegramIds } },
      select: { id: true, telegramId: true },
    });
    if (!telegramUsers.some((u) => u.telegramId != null)) {
      console.log(
        `[notifications] telegram skipped for type=${type}, recipients have no telegramId (appealId=${appealId})`
      );
    }
  }

  // 5. Отправить push
  await Promise.allSettled(
    finalPushIds.map((userId) =>
      sendPushToUser(userId, {
        title,
        body,
        data: { type, appealId, appealNumber, ...pushData },
        sound: 'default',
        channelId: 'appeal-message',
      })
    )
  );

  // 6. Отправить Telegram
  const telegramResults = await Promise.allSettled(
    telegramUsers
      .filter((u) => u.telegramId != null)
      .map((u) =>
        sendTelegramInfoMessage({
          chatId: u.telegramId!,
          text: telegramText,
          parseMode: 'HTML',
          disableLinkPreview: true,
        })
      )
  );
  telegramResults.forEach((result) => {
    if (result.status === 'rejected') {
      console.warn('[notifications] telegram send failed:', result.reason?.message || result.reason);
    }
  });
}

// ---- Helpers ----

async function getOnlineUsersSet(userIds: number[]): Promise<Set<number>> {
  if (!userIds.length) return new Set<number>();
  const presence = await getPresenceForUsers(userIds);
  return new Set(presence.filter((p) => p.isOnline).map((p) => p.userId));
}

function resolveTypePush(
  type: AppealNotificationType,
  s: { pushNewMessage: boolean; pushStatusChanged: boolean; pushDeadlineChanged: boolean }
): boolean {
  switch (type) {
    case 'NEW_MESSAGE':     return s.pushNewMessage;
    case 'STATUS_CHANGED':  return s.pushStatusChanged;
    case 'DEADLINE_CHANGED': return s.pushDeadlineChanged;
    default:                return true;
  }
}

function shouldSuppressTelegramForOnline(type: AppealNotificationType): boolean {
  // Основной переключатель: список типов через запятую.
  // Пример: NEW_MESSAGE,STATUS_CHANGED,DEADLINE_CHANGED
  const raw = String(process.env.TELEGRAM_SUPPRESS_ONLINE_TYPES || '').trim();
  if (raw) {
    const set = new Set(
      raw
        .split(',')
        .map((v) => v.trim().toUpperCase())
        .filter(Boolean)
    );
    return set.has(type);
  }

  // Legacy-совместимость: если включён старый флаг для NEW_MESSAGE,
  // сохраняем прежнее поведение + suppress для status/deadline по умолчанию.
  const legacyNewMessageOn =
    String(process.env.TELEGRAM_SUPPRESS_ONLINE_NEW_MESSAGE || '1') !== '0';

  if (type === 'NEW_MESSAGE') return legacyNewMessageOn;
  if (type === 'STATUS_CHANGED' || type === 'DEADLINE_CHANGED') return true;
  return false;
}

function resolveTypeTelegram(
  type: AppealNotificationType,
  s: {
    telegramNewAppeal: boolean;
    telegramStatusChanged: boolean;
    telegramDeadlineChanged: boolean;
    telegramUnreadReminder: boolean;
    telegramClosureReminder: boolean;
    telegramNewMessage: boolean;
  }
): boolean {
  switch (type) {
    case 'NEW_APPEAL':           return s.telegramNewAppeal;
    case 'STATUS_CHANGED':       return s.telegramStatusChanged;
    case 'DEADLINE_CHANGED':     return s.telegramDeadlineChanged;
    case 'UNREAD_REMINDER':      return s.telegramUnreadReminder;
    case 'CLOSURE_REMINDER':     return s.telegramClosureReminder;
    case 'NEW_MESSAGE':          return s.telegramNewMessage;
    default:                     return true;
  }
}
