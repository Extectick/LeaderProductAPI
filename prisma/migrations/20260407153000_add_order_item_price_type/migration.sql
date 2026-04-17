ALTER TABLE "OrderItem"
  ADD COLUMN IF NOT EXISTS "priceTypeId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'OrderItem' AND constraint_name = 'OrderItem_priceTypeId_fkey'
  ) THEN
    ALTER TABLE "OrderItem"
      ADD CONSTRAINT "OrderItem_priceTypeId_fkey"
      FOREIGN KEY ("priceTypeId") REFERENCES "PriceType"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "OrderItem_priceTypeId_idx" ON "OrderItem"("priceTypeId");
