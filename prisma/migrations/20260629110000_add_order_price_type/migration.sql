ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "priceTypeId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'Order' AND constraint_name = 'Order_priceTypeId_fkey'
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT "Order_priceTypeId_fkey"
      FOREIGN KEY ("priceTypeId") REFERENCES "PriceType"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Order_priceTypeId_idx" ON "Order"("priceTypeId");
