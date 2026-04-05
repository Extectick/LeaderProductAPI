ALTER TABLE "StockBalance"
  ADD COLUMN IF NOT EXISTS "inStock" DECIMAL(18,3),
  ADD COLUMN IF NOT EXISTS "shipping" DECIMAL(18,3),
  ADD COLUMN IF NOT EXISTS "clientReserved" DECIMAL(18,3),
  ADD COLUMN IF NOT EXISTS "managerReserved" DECIMAL(18,3),
  ADD COLUMN IF NOT EXISTS "available" DECIMAL(18,3);

UPDATE "StockBalance"
SET
  "inStock" = COALESCE("inStock", "quantity"),
  "clientReserved" = COALESCE("clientReserved", "reserved"),
  "managerReserved" = COALESCE("managerReserved", 0),
  "shipping" = COALESCE("shipping", 0),
  "available" = COALESCE("available", COALESCE("quantity", 0) - COALESCE("reserved", 0))
WHERE
  "inStock" IS NULL
  OR "clientReserved" IS NULL
  OR "managerReserved" IS NULL
  OR "shipping" IS NULL
  OR "available" IS NULL;
