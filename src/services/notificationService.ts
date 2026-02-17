import prisma from '../prisma/client';
import { sendPushToUser } from './pushService';
import { sendTelegramInfoMessage } from './telegramBotService';
import { sendMaxInfoMessage } from './maxBotService';
import { getPresenceForUsers } from './presenceService';

type NotificationSettingsRow = {
  userId: number;
  inAppNotificationsEnabled: boolean;
  telegramNotificationsEnabled: boolean;
  maxNotificationsEnabled: boolean;
  pushNewMessage: boolean;
  pushStatusChanged: boolean;
  pushDeadlineChanged: boolean;
  telegramNewAppeal: boolean;
  telegramStatusChanged: boolean;
  telegramDeadlineChanged: boolean;
  telegramUnreadReminder: boolean;
  telegramClosureReminder: boolean;
  telegramNewMessage: boolean;
  maxNewAppeal: boolean;
  maxStatusChanged: boolean;
  maxDeadlineChanged: boolean;
  maxUnreadReminder: boolean;
  maxClosureReminder: boolean;
  maxNewMessage: boolean;
};

type MuteRow = { userId: number };

export type AppealNotificationType =
  | 'NEW_APPEAL'
  | 'STATUS_CHANGED'
  | 'DEADLINE_CHANGED'
  | 'NEW_MESSAGE'
  | 'UNREAD_REMINDER'
  | 'CLOSURE_REMINDER';

export type NotificationChannel = 'push' | 'telegram' | 'max';

export type NotificationPayload = {
  type: AppealNotificationType;
  appealId: number;
  appealNumber: number;
  title: string;
  body: string;
  telegramText?: string;
  maxText?: string;
  pushData?: Record<string, any>;
  channels: NotificationChannel[];
  recipientUserIds: number[];
  excludeSenderUserId?: number;
  respectMute?: boolean;
};

export async function dispatchNotification(payload: NotificationPayload): Promise<void> {
  const {
    type,
    appealId,
    appealNumber,
    title,
    body,
    telegramText,
    maxText,
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

  const pushCandidates: number[] = [];
  const telegramCandidates: number[] = [];
  const maxCandidates: number[] = [];

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

    if (channels.includes('max')) {
      const globalOn = s ? s.maxNotificationsEnabled : true;
      const typeOn = s ? resolveTypeMax(type, s) : true;
      if (globalOn && typeOn) maxCandidates.push(userId);
    }
  }

  const onlineSet = await getOnlineUsersSet(
    Array.from(new Set([...pushCandidates, ...telegramCandidates, ...maxCandidates]))
  );
  const finalPushIds = pushCandidates.filter((id) => !onlineSet.has(id));
  const finalTelegramIds = shouldSuppressForOnline('telegram', type)
    ? telegramCandidates.filter((id) => !onlineSet.has(id))
    : telegramCandidates;
  const finalMaxIds = shouldSuppressForOnline('max', type)
    ? maxCandidates.filter((id) => !onlineSet.has(id))
    : maxCandidates;

  if (shouldSuppressForOnline('telegram', type) && telegramCandidates.length && !finalTelegramIds.length) {
    console.log(
      `[notifications] telegram skipped for type=${type}, all recipients are online (appealId=${appealId})`
    );
  }

  if (shouldSuppressForOnline('max', type) && maxCandidates.length && !finalMaxIds.length) {
    console.log(
      `[notifications] max skipped for type=${type}, all recipients are online (appealId=${appealId})`
    );
  }

  let telegramUsers: { id: number; telegramId: bigint | null }[] = [];
  if (finalTelegramIds.length && telegramText) {
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

  let maxUsers: { id: number; maxId: bigint | null }[] = [];
  if (finalMaxIds.length && maxText) {
    maxUsers = await prisma.user.findMany({
      where: { id: { in: finalMaxIds } },
      select: { id: true, maxId: true },
    });
    if (!maxUsers.some((u) => u.maxId != null)) {
      console.log(
        `[notifications] max skipped for type=${type}, recipients have no maxId (appealId=${appealId})`
      );
    }
  }

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

  if (telegramText) {
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

  if (maxText) {
    const maxResults = await Promise.allSettled(
      maxUsers
        .filter((u) => u.maxId != null)
        .map((u) =>
          sendMaxInfoMessage({
            chatId: u.maxId!,
            text: maxText,
            parseMode: 'HTML',
            disableLinkPreview: true,
          })
        )
    );
    maxResults.forEach((result) => {
      if (result.status === 'rejected') {
        console.warn('[notifications] max send failed:', result.reason?.message || result.reason);
      }
    });
  }
}

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
    case 'NEW_MESSAGE': return s.pushNewMessage;
    case 'STATUS_CHANGED': return s.pushStatusChanged;
    case 'DEADLINE_CHANGED': return s.pushDeadlineChanged;
    default: return true;
  }
}

function shouldSuppressForOnline(channel: 'telegram' | 'max', type: AppealNotificationType): boolean {
  if (channel === 'max') {
    const maxRaw = String(process.env.MAX_SUPPRESS_ONLINE_TYPES || '').trim();
    if (!maxRaw) return false;
    const set = new Set(
      maxRaw
        .split(',')
        .map((v) => v.trim().toUpperCase())
        .filter(Boolean)
    );
    return set.has(type);
  }

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
    case 'NEW_APPEAL': return s.telegramNewAppeal;
    case 'STATUS_CHANGED': return s.telegramStatusChanged;
    case 'DEADLINE_CHANGED': return s.telegramDeadlineChanged;
    case 'UNREAD_REMINDER': return s.telegramUnreadReminder;
    case 'CLOSURE_REMINDER': return s.telegramClosureReminder;
    case 'NEW_MESSAGE': return s.telegramNewMessage;
    default: return true;
  }
}

function resolveTypeMax(
  type: AppealNotificationType,
  s: {
    maxNewAppeal: boolean;
    maxStatusChanged: boolean;
    maxDeadlineChanged: boolean;
    maxUnreadReminder: boolean;
    maxClosureReminder: boolean;
    maxNewMessage: boolean;
  }
): boolean {
  switch (type) {
    case 'NEW_APPEAL': return s.maxNewAppeal;
    case 'STATUS_CHANGED': return s.maxStatusChanged;
    case 'DEADLINE_CHANGED': return s.maxDeadlineChanged;
    case 'UNREAD_REMINDER': return s.maxUnreadReminder;
    case 'CLOSURE_REMINDER': return s.maxClosureReminder;
    case 'NEW_MESSAGE': return s.maxNewMessage;
    default: return true;
  }
}
