-- Product images synced from 1C attached files to S3.

CREATE TYPE "ProductImageSyncState" AS ENUM ('PENDING', 'SYNCED', 'ERROR', 'DELETED');

CREATE TABLE "ProductImage" (
  "id" TEXT NOT NULL,
  "productGuid" TEXT NOT NULL,
  "fileGuid" TEXT NOT NULL,
  "isMain" BOOLEAN NOT NULL DEFAULT false,
  "fileName" TEXT,
  "contentType" TEXT,
  "size" INTEGER,
  "width" INTEGER,
  "height" INTEGER,
  "hashSha256" TEXT NOT NULL,
  "s3KeyThumb" TEXT NOT NULL,
  "s3KeyPreview" TEXT NOT NULL,
  "s3KeyOriginal" TEXT,
  "modifiedAt1c" TIMESTAMP(3),
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "syncState" "ProductImageSyncState" NOT NULL DEFAULT 'SYNCED',
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductImage_fileGuid_hashSha256_key" ON "ProductImage"("fileGuid", "hashSha256");
CREATE INDEX "ProductImage_productGuid_isMain_idx" ON "ProductImage"("productGuid", "isMain");
CREATE INDEX "ProductImage_productGuid_deletedAt_idx" ON "ProductImage"("productGuid", "deletedAt");
CREATE INDEX "ProductImage_syncState_idx" ON "ProductImage"("syncState");

