export const CLIENT_ORDER_DEFAULT_DELIVERY_METHOD = 'ДоКлиента';

/** Apply a default only to editable new drafts, never frozen export packets. */
export function resolveDraftDeliveryMethod(value?: string | null, previous?: string | null, existingNumber1c?: string | null): string | null {
  return value?.trim() || previous?.trim() || (existingNumber1c ? null : CLIENT_ORDER_DEFAULT_DELIVERY_METHOD);
}
