import { clientOrderMutationSchema, clientOrderSubmitSchema } from '../src/modules/clientOrders/clientOrders.schemas';

const geoEvent = {
  clientEventId: 'created-unique-123',
  type: 'CREATED' as const,
  status: 'CAPTURED' as const,
  capturedAt: '2026-09-04T04:00:00.000Z',
  latitude: 54.9893,
  longitude: 73.3686,
  accuracy: 12,
  source: 'fresh',
};

describe('client order geo events', () => {
  it('accepts an idempotent submit location event', () => {
    const result = clientOrderSubmitSchema.safeParse({
      revision: 3,
      geoEvents: [{ ...geoEvent, type: 'SUBMITTED' }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.geoEvents?.[0].capturedAt).toBeInstanceOf(Date);
  });

  it('rejects CAPTURED without a complete coordinate pair', () => {
    const result = clientOrderSubmitSchema.safeParse({
      revision: 3,
      geoEvents: [{ ...geoEvent, longitude: undefined }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an unavailable location without blocking the order', () => {
    const base = {
      organizationGuid: 'organization',
      counterpartyGuid: 'counterparty',
      agreementGuid: null,
      contractGuid: null,
      warehouseGuid: null,
      deliveryAddressGuid: null,
      priceTypeGuid: null,
      paymentForm: null,
      deliveryMethod: null,
      invoiceRequested: false,
      saveReason: 'manual',
      items: [{ productGuid: 'product', quantity: 1 }],
      clientRevision: 1,
      intent: 'SAVE',
      geoEvents: [{
        clientEventId: 'created-unavailable-123',
        type: 'CREATED',
        status: 'PERMISSION_DENIED',
        capturedAt: '2026-09-04T04:00:00.000Z',
        reason: 'LOCATION_PERMISSION_DENIED',
      }],
    };
    expect(clientOrderMutationSchema.safeParse(base).success).toBe(true);
  });
});
