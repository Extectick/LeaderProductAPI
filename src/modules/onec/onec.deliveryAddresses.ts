import type { Prisma } from '@prisma/client';
import type { CounterpartyItem } from './onec.schemas';

/** Absent/partial lists from old extensions never remove existing addresses. */
export async function applyCounterpartyAddresses(
  tx: Prisma.TransactionClient,
  counterpartyId: string,
  item: CounterpartyItem,
  syncedAt: Date
) {
  if (item.addressesComplete && (!Array.isArray(item.addresses)
    || item.addresses.some(address => !address.guid?.trim()))) {
    throw new Error('Incomplete delivery address snapshot');
  }
  const sourceUpdatedAt = item.sourceUpdatedAt ?? syncedAt;
  for (const address of item.addresses ?? []) {
    const guid = address.guid?.trim() || null;
    const data = {
      counterpartyId, guid,
      name: address.name ?? null,
      fullAddress: address.fullAddress,
      city: address.city ?? null, street: address.street ?? null,
      house: address.house ?? null, building: address.building ?? null,
      apartment: address.apartment ?? null, postcode: address.postcode ?? null,
      comment: address.comment ?? undefined, kindName: address.kindName ?? undefined,
      isDefault: address.isDefault ?? false,
      isActive: item.isActive !== false && address.isActive !== false,
      sourceUpdatedAt: address.sourceUpdatedAt ?? sourceUpdatedAt,
      lastSyncedAt: syncedAt,
    };
    if (guid) {
      await tx.deliveryAddress.upsert({
        where: { counterpartyId_guid: { counterpartyId, guid } },
        create: data, update: data,
      });
    } else {
      await tx.deliveryAddress.create({ data });
    }
  }
  if (item.addressesComplete) {
    const guids = item.addresses!.map(address => address.guid!.trim());
    await tx.deliveryAddress.updateMany({
      where: { counterpartyId, isActive: true,
        ...(guids.length ? { OR: [{ guid: null }, { guid: { notIn: guids } }] } : {}) },
      data: { isActive: false, isDefault: false, sourceUpdatedAt, lastSyncedAt: syncedAt },
    });
  }
}
