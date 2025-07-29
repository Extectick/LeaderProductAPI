-- CreateEnum
CREATE TYPE "QRStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DELETED');

-- CreateTable
CREATE TABLE "QRList" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "QRStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" INTEGER NOT NULL,
    "qrData" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "QRList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QRAnalytic" (
    "id" SERIAL NOT NULL,
    "ip" TEXT,
    "location" TEXT,
    "browser" TEXT,
    "device" TEXT,
    "scanDuration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qrListId" TEXT NOT NULL,

    CONSTRAINT "QRAnalytic_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "QRList" ADD CONSTRAINT "QRList_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QRAnalytic" ADD CONSTRAINT "QRAnalytic_qrListId_fkey" FOREIGN KEY ("qrListId") REFERENCES "QRList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
