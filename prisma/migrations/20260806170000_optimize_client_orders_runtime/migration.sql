-- Keep client-order list pagination and lightweight invoice polling index-backed.
CREATE INDEX IF NOT EXISTS "Order_number1c_idx" ON "Order"("number1c");
CREATE INDEX IF NOT EXISTS "Order_source_createdByUserId_updatedAt_id_idx"
  ON "Order"("source", "createdByUserId", "updatedAt", "id");
CREATE INDEX IF NOT EXISTS "Order_source_createdByUserId_status_updatedAt_id_idx"
  ON "Order"("source", "createdByUserId", "status", "updatedAt", "id");

CREATE INDEX IF NOT EXISTS "ClientOrderInvoice_orderId_state_updatedAt_version_idx"
  ON "ClientOrderInvoice"("orderId", "state", "updatedAt", "version");
CREATE INDEX IF NOT EXISTS "ClientOrderInvoice_state_readyAt_nextAttemptAt_leaseUntil_updatedAt_idx"
  ON "ClientOrderInvoice"("state", "readyAt", "nextAttemptAt", "leaseUntil", "updatedAt");
