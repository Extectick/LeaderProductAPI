import request from 'supertest';

jest.mock('../../src/services/telegramBotService', () => {
  const actual = jest.requireActual('../../src/services/telegramBotService');
  return {
    ...actual,
    sendTelegramInfoMessage: jest.fn().mockResolvedValue(true),
  };
});

import app from '../../src';
import { sendTelegramInfoMessage } from '../../src/services/telegramBotService';

describe('Auth: Telegram webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('silences contact updates when no pending session exists', async () => {
    const telegramId = 9000000001;
    const response = await request(app)
      .post('/auth/telegram/webhook')
      .send({
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          from: {
            id: telegramId,
            is_bot: false,
            first_name: 'Test',
          },
          chat: {
            id: telegramId,
            type: 'private',
          },
          contact: {
            phone_number: '+7 999 000 1122',
            user_id: telegramId,
            first_name: 'Test',
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body?.ok).toBe(true);
    expect(sendTelegramInfoMessage).not.toHaveBeenCalled();
  });
});
