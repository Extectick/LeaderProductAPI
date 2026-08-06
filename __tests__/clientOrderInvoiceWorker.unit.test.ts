jest.mock('../src/prisma/client', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    clientOrderInvoice: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../src/lib/redis', () => ({ getRedis: jest.fn() }));
jest.mock('../src/modules/onec/onec.lpApp.client', () => ({
  ackOnecLpAppClientOrderInvoice: jest.fn(),
  getOnecLpAppClientOrderInvoicePdf: jest.fn(),
  getOnecLpAppClientOrderInvoices: jest.fn(),
  validateOnecLpAppClientOrderInvoice: jest.fn(),
}));
jest.mock('../src/storage/minio', () => ({
  buildStoragePrefix: jest.fn(),
  uploadBuffer: jest.fn(),
  downloadBuffer: jest.fn(),
}));
jest.mock('../src/services/telegramBotService', () => ({ sendTelegramDocument: jest.fn() }));
jest.mock('../src/services/maxBotService', () => ({ sendMaxDocument: jest.fn() }));

import prisma from '../src/prisma/client';
import {
  ackOnecLpAppClientOrderInvoice,
  getOnecLpAppClientOrderInvoicePdf,
  validateOnecLpAppClientOrderInvoice,
} from '../src/modules/onec/onec.lpApp.client';
import { buildStoragePrefix, uploadBuffer } from '../src/storage/minio';
import {
  buildInvoiceFileName,
  buildInvoiceMessage,
  processInvoice,
  syncQueueItem,
} from '../src/services/clientOrderInvoiceWorker';

describe('clientOrderInvoiceWorker queue synchronization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a new version even when its hash matches an older sent invoice', async () => {
    const tx = {
      order: {
        findFirst: jest.fn().mockResolvedValue({ id: 'order-1' }),
      },
      clientOrderInvoice: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({ id: 'invoice-v3' }),
      },
    };
    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await syncQueueItem({
      appOrderGuid: 'app-order-guid',
      orderGuid: 'onec-order-guid',
      realizationGuid: 'realization-guid',
      realizationNumber: 'НОУТ-H04002',
      state: 'READY',
      waitReason: '',
      businessHash: 'hash-from-v1',
      version: 3,
      token: 'token-v3',
      readyAt: '2099-08-03T19:39:00Z',
      updatedAt: '2026-08-03T19:39:00',
    }, { immediate: true });

    expect(tx.clientOrderInvoice.findFirst).not.toHaveBeenCalled();
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: { guid: 'app-order-guid' },
      select: { id: true },
    });
    expect(tx.clientOrderInvoice.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { token: 'token-v3' },
      create: expect.objectContaining({
        token: 'token-v3',
        version: 3,
        businessHash: 'hash-from-v1',
        state: 'QUEUED',
        readyAt: expect.any(Date),
      }),
    }));
    const createData = tx.clientOrderInvoice.upsert.mock.calls[0][0].create;
    expect(createData.readyAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('stores a ready PDF without bot delivery when automatic delivery is disabled', async () => {
    const invoice = {
      id: 'invoice-manual',
      token: 'token-manual',
      businessHash: 'hash-manual',
      realizationGuid: 'realization-guid',
      realizationNumber: 'НОУТ-H04002',
      realizationDate: new Date('2026-08-04T00:00:00.000Z'),
      invoiceAmount: 5628,
      currency: 'RUB',
      counterpartyName: 'Клиент',
      organizationName: 'Организация',
      orderNumber: 'НОУТ-086849',
      version: 1,
      s3Key: null,
      fileName: null,
      attempts: 0,
      order: {
        invoiceRequested: false,
        number1c: 'НОУТ-086849',
        date1c: new Date('2026-08-03T00:00:00.000Z'),
        totalAmount: 5628,
        currency: 'RUB',
        createdByUser: null,
      },
    };
    const clientOrderInvoice = (prisma as any).clientOrderInvoice;
    clientOrderInvoice.updateMany.mockResolvedValueOnce({ count: 1 });
    clientOrderInvoice.findUnique
      .mockResolvedValueOnce(invoice)
      .mockResolvedValueOnce({
        s3Key: 'dev/invoices/invoice-manual/hash.pdf',
        fileName: 'Счет №НОУТ-H04002 от 04.08.2026.pdf',
        order: { invoiceRequested: false },
      });
    clientOrderInvoice.update.mockResolvedValue({});
    (validateOnecLpAppClientOrderInvoice as jest.Mock).mockResolvedValue({
      appOrderGuid: 'app-order-guid',
      orderGuid: 'order-guid',
      realizationGuid: 'realization-guid',
      state: 'READY',
      businessHash: 'hash-manual',
      version: 1,
      token: 'token-manual',
    });
    (getOnecLpAppClientOrderInvoicePdf as jest.Mock).mockResolvedValue({
      body: Buffer.from('%PDF-1.7 manual invoice'),
      contentType: 'application/pdf',
    });
    (buildStoragePrefix as jest.Mock).mockReturnValue('dev/invoices');
    (uploadBuffer as jest.Mock).mockResolvedValue(undefined);
    (ackOnecLpAppClientOrderInvoice as jest.Mock).mockResolvedValue({});

    await processInvoice('invoice-manual');

    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    expect(clientOrderInvoice.update).toHaveBeenLastCalledWith({
      where: { id: 'invoice-manual' },
      data: expect.objectContaining({
        state: 'AVAILABLE',
        waitReason: null,
        leaseUntil: null,
        nextAttemptAt: null,
      }),
    });
    expect(ackOnecLpAppClientOrderInvoice).toHaveBeenCalledWith('token-manual', {
      state: 'STORED',
      error: null,
      sentAt: null,
    });
  });

  it('omits version for the first invoice and includes it for repeated versions', () => {
    expect(buildInvoiceFileName({
      realizationNumber: 'НОУТ-H04002',
      realizationGuid: 'realization-guid',
      realizationDate: new Date('2026-08-04T00:00:00.000Z'),
      version: 1,
    })).toBe('Счет №НОУТ-H04002 от 04.08.2026.pdf');

    expect(buildInvoiceFileName({
      realizationNumber: 'НОУТ-H04002',
      realizationGuid: 'realization-guid',
      realizationDate: new Date('2026-08-04T00:00:00.000Z'),
      version: 3,
    })).toBe('Счет №НОУТ-H04002 от 04.08.2026, версия 3.pdf');
  });

  it('builds a client-ready message and marks repeated versions as updated', () => {
    const message = buildInvoiceMessage({
      realizationNumber: 'НОУТ-H04002',
      realizationGuid: 'realization-guid',
      realizationDate: '2026-08-04',
      version: 3,
      invoiceAmount: 5628,
      currency: 'RUB',
      counterpartyName: 'Колмогоров Андрей Викторович ИП',
      organizationName: 'Новичков Станислав Юрьевич ИП',
      orderNumber: 'НОУТ-086849',
    });

    expect(message).toBe(
      'Добрый день!\n' +
        'Направляем счёт на оплату НОУТ-H04002 от 04.08.2026.\n' +
        'Сумма к оплате: 5 628,00 ₽.'
    );
  });
});
