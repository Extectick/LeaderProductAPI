import {
  clientOrderCreateSchema,
  clientOrdersListQuerySchema,
  clientOrdersProductsQuerySchema,
} from '../src/modules/clientOrders/clientOrders.schemas';
import { orderAckSchema, ordersSnapshotBatchSchema } from '../src/modules/onec/onec.schemas';

describe('client orders query schemas', () => {
  it('parses inStockOnly=false as false', () => {
    const result = clientOrdersProductsQuerySchema.parse({ inStockOnly: 'false' });
    expect(result.inStockOnly).toBe(false);
  });

  it('parses inStockOnly=true as true', () => {
    const result = clientOrdersProductsQuerySchema.parse({ inStockOnly: 'true' });
    expect(result.inStockOnly).toBe(true);
  });

  it('keeps pagination defaults stable', () => {
    expect(clientOrdersListQuerySchema.parse({})).toMatchObject({
      limit: 20,
      offset: 0,
      onlyProblems: false,
    });
  });

  it('keeps header price type in manager order payload', () => {
    const result = clientOrderCreateSchema.parse({
      organizationGuid: 'organization-guid',
      counterpartyGuid: 'counterparty-guid',
      agreementGuid: null,
      contractGuid: null,
      warehouseGuid: null,
      deliveryAddressGuid: null,
      priceTypeGuid: 'price-type-guid',
      saveReason: 'manual',
      items: [{ lineGuid: 'line-guid-1', productGuid: 'product-guid', quantity: 1, priceTypeGuid: null }],
    });

    expect(result.priceTypeGuid).toBe('price-type-guid');
    expect(result.items[0].lineGuid).toBe('line-guid-1');
  });

  it('accepts cancelled snapshot lines with reason metadata', () => {
    const parsed = ordersSnapshotBatchSchema.parse({
      secret: 'secret',
      items: [{
        guid: 'app-guid',
        baseRevision: 1,
        revision: 2,
        status: 'CONFIRMED',
        isPostedIn1c: true,
        hasRealization: true,
        readOnlyReason: 'По заказу создана проведенная реализация товаров и услуг.',
        sourceUpdatedAt: '2026-06-29T00:00:00.000Z',
        date1c: '2026-06-29T00:00:00.000Z',
        deliveryDate: null,
        items: [{
          lineGuid: 'line-guid-1',
          appLineGuid: 'line-guid-1',
          product: { guid: 'product-guid', name: 'Товар' },
          quantity: 0,
          quantityBase: 0,
          price: 0,
          isCancelled: true,
          cancelReasonGuid: 'reason-guid',
          cancelReasonName: 'Нет остатка',
          cancelReason: 'Нет остатка',
          cancelledAmount: 500,
        }],
      }],
    });

    expect(parsed.items[0].hasRealization).toBe(true);
    expect(parsed.items[0].items[0]).toMatchObject({
      lineGuid: 'line-guid-1',
      appLineGuid: 'line-guid-1',
      isCancelled: true,
      cancelReasonGuid: 'reason-guid',
      cancelledAmount: 500,
    });
  });

  it('accepts cancelled 1C ack for queued cancel requests', () => {
    const parsed = orderAckSchema.parse({
      secret: 'secret',
      status: 'CANCELLED',
      number1c: 'НОУТ-073955',
      date1c: '2026-06-29T13:03:09.000Z',
      sentTo1cAt: '2026-06-30T01:00:00.000Z',
    });

    expect(parsed.status).toBe('CANCELLED');
    expect(parsed.number1c).toBe('НОУТ-073955');
  });
});
