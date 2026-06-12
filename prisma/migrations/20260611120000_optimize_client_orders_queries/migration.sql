CREATE INDEX IF NOT EXISTS "StockBalance_warehouseId_productId_idx"
  ON "StockBalance"("warehouseId", "productId");

CREATE INDEX IF NOT EXISTS "ProductPrice_productId_priceTypeId_isActive_idx"
  ON "ProductPrice"("productId", "priceTypeId", "isActive");

CREATE INDEX IF NOT EXISTS "Order_source_updatedAt_idx"
  ON "Order"("source", "updatedAt");

CREATE INDEX IF NOT EXISTS "Order_source_status_updatedAt_idx"
  ON "Order"("source", "status", "updatedAt");
