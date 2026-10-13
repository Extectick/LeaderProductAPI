-- Bounded product pages and their series detail must not scan all stock rows.
CREATE INDEX IF NOT EXISTS "StockBalance_productId_idx" ON "StockBalance"("productId");
