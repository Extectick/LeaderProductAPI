import type { OrderDetailRecord } from '../orders/orderModel';
import type { mapOrderDetail } from '../orders/orderModel';
import type { LiveClientOrder } from './clientOrders.onecLive';
import { restoreClientOrderDetailSnapshot } from './clientOrders.onecLive';

type MappedOrder = ReturnType<typeof mapOrderDetail>;

/** Read-only projection: invoice bookkeeping never becomes an editable order. */
export function invoiceShadowListSnapshot(snapshot: unknown, guid: string): LiveClientOrder | null {
  const root = snapshot as { invoiceShadow?: boolean; item?: { documentGuid?: string; appGuid?: string } } | null;
  if (!root?.invoiceShadow || !root.item?.documentGuid) return null;
  if (![root.item.documentGuid, root.item.appGuid].some(id => id?.toLowerCase() === guid.toLowerCase())) return null;
  const detail = restoreClientOrderDetailSnapshot(root.item, root.item.documentGuid);
  return detail?.isDeleted ? null : detail;
}

/** Invoice bookkeeping is not an editable API-owned order document. */
export function isInvoiceShadowOrder(order: Pick<OrderDetailRecord, 'last1cSnapshot' | 'items' | 'clientOrderId' | 'syncState'>) {
  const snapshot = order.last1cSnapshot;
  return !!snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && snapshot.invoiceShadow === true && order.items.length === 0
    && !order.clientOrderId && order.syncState === 'SYNCED';
}

export function invoiceShadowDetail(mapped: MappedOrder, detail: LiveClientOrder, stale = false) {
  return {
    ...mapped,
    // Unlike an editable draft, the shadow has no authoritative document content.
    ...detail,
    guid: mapped.guid,
    appGuid: mapped.guid,
    origin: 'merged' as const,
    source: mapped.source,
    revision: mapped.revision,
    // A token for an empty shadow must never authorize editing the displayed rows.
    contentToken: undefined,
    readOnly: true,
    readOnlyReason: detail.readOnlyReason || 'Документ из 1С доступен только для просмотра.',
    hasRealization: detail.hasRealization || mapped.hasRealization,
    realizationDetectedAt: mapped.realizationDetectedAt,
    queuePosition: null,
    invoiceRequested: mapped.invoiceRequested,
    invoiceState: mapped.invoiceState,
    invoiceWaitReason: mapped.invoiceWaitReason,
    latestInvoiceVersion: mapped.latestInvoiceVersion,
    invoiceCount: mapped.invoiceCount,
    invoiceDownloadAvailable: mapped.invoiceDownloadAvailable,
    invoices: mapped.invoices,
    events: mapped.events,
    stale,
  };
}
