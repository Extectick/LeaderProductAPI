import type { ClientOrderMutationBody } from './clientOrders.schemas';

type Line = ClientOrderMutationBody['items'][number];
type PriceInput = { line: Line; productName: string; currentPrice: number | null; quantityBase: number };

/** A missing price is not a new zero price. This helper never mutates the packet. */
export function reviewOfflineOrderPrices(
  inputs: PriceInput[],
  policy: 'ASK' | 'USE_CURRENT' | 'KEEP_DRAFT',
  generalDiscountPercent?: number | null,
) {
  let oldTotal = 0;
  let currentTotal = 0;
  const changes: Array<{ lineGuid: string | null; productGuid: string; productName: string;
    oldPrice: number; currentPrice: number | null; priceAvailable: boolean }> = [];
  const items = inputs.map(({ line, productName, currentPrice, quantityBase }) => {
    if (line.isCancelled) return line;
    const oldPrice = Number(line.manualPrice ?? line.basePrice ?? 0);
    const manual = line.manualPrice != null;
    const available = currentPrice !== null && Number.isFinite(currentPrice) && currentPrice > 0;
    const discount = Number(line.discountPercent ?? (manual ? 0 : generalDiscountPercent) ?? 0);
    const amountFactor = quantityBase * (1 - discount / 100);
    oldTotal += oldPrice * amountFactor;
    currentTotal += (manual ? oldPrice : available ? currentPrice! : 0) * amountFactor;
    if (manual) return line;
    if (!available || Math.abs(oldPrice - currentPrice!) > 0.0001) changes.push({
      lineGuid: line.lineGuid ?? null, productGuid: line.productGuid, productName, oldPrice,
      currentPrice: available ? currentPrice : null, priceAvailable: available,
    });
    if (policy === 'KEEP_DRAFT' && Number.isFinite(oldPrice) && oldPrice > 0) {
      // Preserve the effective discount when converting an automatic price to fixed.
      return { ...line, manualPrice: oldPrice, basePrice: oldPrice,
        discountPercent: line.discountPercent ?? generalDiscountPercent ?? null };
    }
    return policy === 'USE_CURRENT' && available ? { ...line, basePrice: currentPrice! } : line;
  });
  const missingPrices = changes.filter(change => !change.priceAvailable);
  const canKeepDraft = inputs.every(({ line }) => line.isCancelled
    || (Number.isFinite(Number(line.manualPrice ?? line.basePrice)) && Number(line.manualPrice ?? line.basePrice) > 0));
  const requiresReview = policy === 'KEEP_DRAFT' ? !canKeepDraft
    : missingPrices.length > 0 || (policy === 'ASK' && changes.length > 0);
  return { items, requiresReview, details: {
    items: changes, missingPrices, canUseCurrent: missingPrices.length === 0, canKeepDraft,
    oldTotal: Math.round(oldTotal * 100) / 100,
    currentTotal: missingPrices.length ? null : Math.round(currentTotal * 100) / 100,
    totalDifference: missingPrices.length ? null : Math.round((currentTotal - oldTotal) * 100) / 100,
  } };
}

export function offlineProductPriceKey(productGuid: string, priceTypeGuid?: string | null) {
  return `${productGuid.toLowerCase()}|${(priceTypeGuid ?? '').toLowerCase()}`;
}
