export type ExpoPushMessage = Record<string, unknown>;
export type ExpoPushTicket = { status: 'ok' | 'error'; details?: { error?: string } };

export class Expo {
  static isExpoPushToken(token: string) {
    return token.startsWith('Expo');
  }

  chunkPushNotifications(messages: ExpoPushMessage[]) {
    return [messages];
  }

  async sendPushNotificationsAsync(messages: ExpoPushMessage[]) {
    return messages.map(() => ({ status: 'ok' as const }));
  }
}
