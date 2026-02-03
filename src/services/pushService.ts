import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import prisma from '../prisma/client';

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
});

type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: 'default' | null;
  channelId?: string;
};

export async function sendPushToUser(userId: number, payload: PushPayload) {
  const tokens = await prisma.deviceToken.findMany({
    where: { userId },
  });

  const expoTokens = tokens
    .map((t) => t.token)
    .filter((token) => Expo.isExpoPushToken(token));

  if (!expoTokens.length) {
    return { ok: false, reason: 'no_tokens' as const };
  }

  const messages: ExpoPushMessage[] = expoTokens.map((token) => ({
    to: token,
    title: payload.title,
    body: payload.body,
    data: payload.data,
    sound: payload.sound ?? 'default',
    channelId: payload.channelId,
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];

  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    } catch (error) {
      console.error('[push] Failed to send chunk', error);
    }
  }

  // Remove invalid tokens immediately if Expo reports them
  const invalidTokens: string[] = [];
  tickets.forEach((ticket, idx) => {
    if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
      const token = (messages[idx]?.to as string) || '';
      if (token) invalidTokens.push(token);
    }
  });

  if (invalidTokens.length) {
    await prisma.deviceToken.deleteMany({
      where: { token: { in: invalidTokens } },
    });
  }

  return { ok: true, ticketsCount: tickets.length };
}

export async function notifyProfileActivated(userId: number, profileType: string) {
  const label =
    profileType === 'EMPLOYEE'
      ? 'Сотрудник'
      : profileType === 'CLIENT'
      ? 'Клиент'
      : profileType === 'SUPPLIER'
      ? 'Поставщик'
      : 'Профиль';

  return sendPushToUser(userId, {
    title: 'Профиль подтверждён',
    body: `Ваш профиль «${label}» активирован. Можно входить в приложение.`,
    data: { type: 'PROFILE_STATUS', profileType, status: 'ACTIVE' },
    sound: 'default',
    channelId: 'profile-status',
  });
}

