const mockSendMessageToUser = jest.fn();

jest.mock('@maxhub/max-bot-api', () => ({
  Bot: jest.fn().mockImplementation(() => ({
    api: {
      sendMessageToUser: mockSendMessageToUser,
    },
    on: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  })),
}));

import { sendMaxDocument } from '../src/services/maxBotService';

describe('MAX document delivery', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.MAX_BOT_TOKEN = 'test-max-token';
    process.env.MAX_BOT_USERNAME = 'test-max-bot';
    mockSendMessageToUser.mockReset().mockResolvedValue({ body: { mid: 'message-1' } });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uploads a PDF with its real filename and MIME type', async () => {
    const pdf = Buffer.from('%PDF-1.7 test invoice');
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'https://fu.oneme.ru/upload-test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'file-token-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    global.fetch = fetchMock as typeof fetch;

    await expect(
      sendMaxDocument({
        chatId: '12345',
        buffer: pdf,
        fileName: 'Счет №НОУТ-H10208 от 10.08.2026.pdf',
        caption: 'Счет на оплату',
      })
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://platform-api2.max.ru/uploads?type=file',
      expect.objectContaining({ method: 'POST' })
    );
    const uploadOptions = fetchMock.mock.calls[1][1] as RequestInit;
    const form = uploadOptions.body as FormData;
    const file = form.get('data') as File;
    expect(file.name).toBe('Счет №НОУТ-H10208 от 10.08.2026.pdf');
    expect(file.type).toBe('application/pdf');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(pdf);
    expect(mockSendMessageToUser).toHaveBeenCalledWith(12345, 'Счет на оплату', {
      attachments: [{ type: 'file', payload: { token: 'file-token-1' } }],
    });
  });

  it('adds the PDF extension and retries attachment processing without reuploading', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'https://fu.oneme.ru/upload-test' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'file-token-2' }), { status: 200 })
      );
    global.fetch = fetchMock as typeof fetch;
    mockSendMessageToUser
      .mockRejectedValueOnce(Object.assign(new Error('attachment.not.ready'), { code: 'attachment.not.ready' }))
      .mockResolvedValueOnce({ body: { mid: 'message-2' } });

    await expect(
      sendMaxDocument({ chatId: 12345, buffer: Buffer.from('%PDF-test'), fileName: 'Счет НОУТ-H10208' })
    ).resolves.toBe(true);

    const uploadOptions = fetchMock.mock.calls[1][1] as RequestInit;
    const file = (uploadOptions.body as FormData).get('data') as File;
    expect(file.name).toBe('Счет НОУТ-H10208.pdf');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSendMessageToUser).toHaveBeenCalledTimes(2);
  });
});
