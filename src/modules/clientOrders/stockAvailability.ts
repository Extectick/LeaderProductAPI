/** Add the owner's reserve BEFORE clamping: a reserve is not extra physical stock. */
export function availableStockForManager(stock: {
  quantity: number | null;
  freeAvailableRaw: number | null;
  myReserved?: number | null;
  available?: number | null;
}): number | null {
  const candidates: number[] = [];
  if (stock.quantity !== null && Number.isFinite(stock.quantity)) candidates.push(Math.max(stock.quantity, 0));
  if (stock.freeAvailableRaw !== null && Number.isFinite(stock.freeAvailableRaw)) {
    const own = stock.myReserved != null && Number.isFinite(stock.myReserved) ? Math.max(stock.myReserved, 0) : 0;
    candidates.push(Math.max(stock.freeAvailableRaw + own, 0));
  }
  // Preserve stricter upstream constraints (series, allocation, etc.).
  if (stock.available != null && Number.isFinite(stock.available)) candidates.push(Math.max(stock.available, 0));
  return candidates.length ? Math.min(...candidates) : null;
}
