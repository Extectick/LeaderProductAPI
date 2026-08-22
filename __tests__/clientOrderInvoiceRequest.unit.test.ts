const mockOrderFindFirst = jest.fn();
const mockOrderFindMany = jest.fn();
const mockInvoiceFindMany = jest.fn();
const mockRequestOnecInvoice = jest.fn();
const mockSyncQueueItem = jest.fn();
const mockProcessInvoice = jest.fn();
const mockEmployeeProfileFindUnique = jest.fn();
const mockFindLiveClientOrder = jest.fn();
const mockGetLiveClientOrder = jest.fn();
const mockTransaction = jest.fn();
const mockTxOrderFindFirst = jest.fn();
const mockTxOrderCreate = jest.fn();
const mockCounterpartyUpsert = jest.fn();
const mockOrganizationUpsert = jest.fn();

jest.mock('../src/prisma/client', () => ({
  __esModule: true,
  default: {
    order: { findFirst: mockOrderFindFirst, findMany: mockOrderFindMany },
    clientOrderInvoice: { findMany: mockInvoiceFindMany },
    employeeProfile: { findUnique: mockEmployeeProfileFindUnique },
    $transaction: mockTransaction,
  },
}));

jest.mock('../src/modules/clientOrders/clientOrders.onecLive', () => ({
  findLiveClientOrder: mockFindLiveClientOrder,
  getLiveClientOrder: mockGetLiveClientOrder,
}));

jest.mock('../src/modules/onec/onec.lpApp.client', () => {
  const actual = jest.requireActual('../src/modules/onec/onec.lpApp.client');
  return {
    ...actual,
    requestOnecLpAppClientOrderInvoice: mockRequestOnecInvoice,
  };
});

jest.mock('../src/services/clientOrderInvoiceWorker', () => ({
  syncQueueItem: mockSyncQueueItem,
  processInvoice: mockProcessInvoice,
}));

import {
  listClientOrderInvoiceStatuses,
  requestClientOrderInvoice,
} from '../src/modules/clientOrders/clientOrderInvoices.service';

describe('manual client order invoice request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmployeeProfileFindUnique.mockResolvedValue(null);
    mockFindLiveClientOrder.mockResolvedValue(null);
    mockOrderFindMany.mockResolvedValue([]);
    mockTransaction.mockImplementation((callback) => callback({
      order: { findFirst: mockTxOrderFindFirst, create: mockTxOrderCreate },
      counterparty: { upsert: mockCounterpartyUpsert },
      organization: { upsert: mockOrganizationUpsert },
    }));
  });

  it('requests 1C, synchronizes the candidate and returns the public version', async () => {
    const queueItem = {
      appOrderGuid: 'order-guid',
      orderGuid: 'onec-order-guid',
      realizationGuid: 'realization-guid',
      state: 'READY',
      version: 1,
      token: 'invoice-token',
    };
    mockOrderFindFirst
      .mockResolvedValueOnce({ id: 'order-id', guid: 'order-guid', number1c: 'НОУТ-1', createdByUserId: 37, last1cSnapshot: null })
      .mockResolvedValueOnce({ id: 'order-id', guid: 'order-guid', number1c: 'НОУТ-1', createdByUserId: 37, last1cSnapshot: null });
    mockInvoiceFindMany.mockResolvedValue([{
      id: 'invoice-id',
      realizationGuid: 'realization-guid',
      realizationNumber: 'НОУТ-H04002',
      realizationDate: new Date('2026-08-04T00:00:00.000Z'),
      version: 1,
      state: 'QUEUED',
      waitReason: null,
      lastError: null,
      s3Key: null,
      fileName: null,
      sentAt: null,
    }]);
    mockRequestOnecInvoice.mockResolvedValue({ requested: true, protocolVersion: '2026-08-05-immediate-invoice-v2', message: 'Формирование счёта запрошено', items: [queueItem] });

    await expect(requestClientOrderInvoice('order-guid', 37)).resolves.toMatchObject({
      requested: true,
      items: [{ id: 'invoice-id', state: 'QUEUED', downloadAvailable: false }],
    });
    expect(mockRequestOnecInvoice).toHaveBeenCalledWith('order-guid');
    expect(mockSyncQueueItem).toHaveBeenCalledWith(queueItem, { immediate: true });
    expect(mockProcessInvoice).toHaveBeenCalledWith('invoice-id');
  });

  it('resolves a legacy 1C document GUID by the app GUID and current 1C manager', async () => {
    const legacyOrder = {
      id: 'legacy-order-id',
      guid: 'e1169e80-18d7-408d-b280-0c50ca474e42',
      number1c: 'НОУТ-086782',
      createdByUserId: 37,
      last1cSnapshot: {
        item: {
          appGuid: 'e1169e80-18d7-408d-b280-0c50ca474e42',
          documentGuid: 'fd923674-867f-11f1-a4a6-d843ae930d20',
          managerGuid: 'f90a0ba2-4df4-11ee-9bda-1c98ec138053',
        },
      },
    };
    mockOrderFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyOrder)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyOrder);
    mockEmployeeProfileFindUnique.mockResolvedValue({ onecUserGuid: 'F90A0BA2-4DF4-11EE-9BDA-1C98EC138053' });
    mockInvoiceFindMany.mockResolvedValue([]);
    mockRequestOnecInvoice.mockResolvedValue({ requested: true, protocolVersion: '2026-08-05-immediate-invoice-v2', items: [] });

    await expect(requestClientOrderInvoice('fd923674-867f-11f1-a4a6-d843ae930d20', 1)).resolves.toMatchObject({
      requested: true,
      items: [],
    });

    expect(mockRequestOnecInvoice).toHaveBeenCalledWith('e1169e80-18d7-408d-b280-0c50ca474e42');
    expect(mockFindLiveClientOrder).not.toHaveBeenCalled();
  });

  it('creates an invoice shadow and requests by document GUID for an order created directly in 1C', async () => {
    const documentGuid = 'fd923674-867f-11f1-a4a6-d843ae930d21';
    const shadowOrder = {
      id: 'shadow-order-id',
      guid: documentGuid,
      number1c: 'НОУТ-086900',
      createdByUserId: 37,
      last1cSnapshot: null,
    };
    const liveOrder = {
      guid: documentGuid,
      appGuid: null,
      documentGuid,
      number1c: 'НОУТ-086900',
      date1c: '2026-08-05T10:00:00',
      source: 'ONEC_LIVE',
      origin: 'onec',
      managerGuid: 'manager-guid',
      readOnly: true,
      readOnlyReason: null,
      hasRealization: true,
      revision: 1,
      syncState: 'SYNCED',
      status: 'CONFIRMED',
      status1c: 'Закрыт',
      currentState1c: null,
      documentStatus1c: null,
      comment: null,
      deliveryDate: null,
      paymentForm: null,
      deliveryMethod: null,
      totalAmount: 5628,
      currency: 'RUB',
      priceType: null,
      queuedAt: null,
      sentTo1cAt: null,
      lastStatusSyncAt: '2026-08-05T10:01:00',
      lastExportError: null,
      last1cError: null,
      isPostedIn1c: true,
      cancelRequestedAt: null,
      counterparty: { guid: 'counterparty-guid', name: 'Контрагент', fullName: null, inn: null, kpp: null },
      organization: { guid: 'organization-guid', name: 'Организация', code: null, isActive: true },
      warehouse: null,
      agreement: null,
      contract: null,
      deliveryAddress: null,
      itemsCount: 0,
      items: [],
      events: [],
      createdAt: null,
      updatedAt: null,
      sourceUpdatedAt: null,
    };

    mockOrderFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(shadowOrder);
    mockEmployeeProfileFindUnique.mockResolvedValue({ onecUserGuid: 'manager-guid' });
    mockGetLiveClientOrder.mockResolvedValue(liveOrder);
    mockFindLiveClientOrder.mockResolvedValue(liveOrder);
    mockTxOrderFindFirst.mockResolvedValue(null);
    mockCounterpartyUpsert.mockResolvedValue({ id: 11 });
    mockOrganizationUpsert.mockResolvedValue({ id: 12 });
    mockTxOrderCreate.mockResolvedValue(shadowOrder);
    mockInvoiceFindMany.mockResolvedValue([]);
    mockRequestOnecInvoice.mockResolvedValue({ requested: true, protocolVersion: '2026-08-05-immediate-invoice-v2', items: [] });

    await expect(requestClientOrderInvoice(documentGuid, 37)).resolves.toMatchObject({
      requested: true,
      items: [],
    });

    expect(mockRequestOnecInvoice).toHaveBeenCalledWith(documentGuid);
    expect(mockTxOrderCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        guid: documentGuid,
        number1c: 'НОУТ-086900',
        createdByUserId: 37,
      }),
    }));
  });

  it('polls owned invoice statuses from PostgreSQL without reading the 1C manager profile', async () => {
    mockOrderFindMany.mockResolvedValueOnce([{
      guid: 'order-guid',
      number1c: 'НОУТ-1',
      last1cSnapshot: null,
      invoices: [{
        id: 'invoice-id',
        realizationGuid: 'realization-guid',
        realizationNumber: 'НОУТ-H1',
        realizationDate: new Date('2026-08-04T00:00:00.000Z'),
        version: 2,
        state: 'AVAILABLE',
        waitReason: null,
        lastError: null,
        s3Key: 'invoices/file.pdf',
        fileName: 'Счет.pdf',
        sentAt: null,
      }],
    }]);

    await expect(listClientOrderInvoiceStatuses(['ORDER-GUID'], 37)).resolves.toEqual({
      items: [{
        identifier: 'order-guid',
        invoices: [expect.objectContaining({
          id: 'invoice-id',
          state: 'AVAILABLE',
          version: 2,
          downloadAvailable: true,
        })],
      }],
    });
    expect(mockEmployeeProfileFindUnique).not.toHaveBeenCalled();
    expect(mockOrderFindMany).toHaveBeenCalledTimes(1);
  });
});
