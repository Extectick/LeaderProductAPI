import request from 'supertest';

process.env.MAX_WEBHOOK_SECRET = 'test-max-webhook-secret';

jest.mock('../../src/services/maxBotService', () => {
  const actual = jest.requireActual('../../src/services/maxBotService');
  return {
    ...actual,
    sendMaxInfoMessage: jest.fn().mockResolvedValue(true),
  };
});

import app from '../../src';
import { sendMaxInfoMessage } from '../../src/services/maxBotService';

describe('Auth: MAX webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects webhook with invalid secret', async () => {
    const response = await request(app)
      .post('/auth/max/webhook')
      .set('X-Max-Bot-Api-Secret', 'wrong-secret')
      .send({});

    expect(response.status).toBe(403);
    expect(response.body?.ok).toBe(false);
  });

  it('silences contact updates when no pending session exists', async () => {
    const maxUserId = 9200000001;
    const response = await request(app)
      .post('/auth/max/webhook')
      .set('X-Max-Bot-Api-Secret', process.env.MAX_WEBHOOK_SECRET as string)
      .send({
        update_type: 'message_created',
        timestamp: Date.now(),
        message: {
          sender: {
            user_id: maxUserId,
            name: 'Test User',
            username: 'max_test_user',
            is_bot: false,
            last_activity_time: Date.now(),
          },
          recipient: { chat_id: maxUserId, chat_type: 'dialog' },
          timestamp: Date.now(),
          body: {
            mid: 'm1',
            seq: 1,
            text: null,
            attachments: [
              {
                type: 'contact',
                payload: {
                  vcf_info: 'BEGIN:VCARD\nVERSION:3.0\nFN:Test User\nTEL:+7 999 000 1122\nEND:VCARD',
                },
              },
            ],
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body?.ok).toBe(true);
    expect(sendMaxInfoMessage).not.toHaveBeenCalled();
  });
});
