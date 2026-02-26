-- CreateEnum
CREATE TYPE "AppealLaborPaymentStatus" AS ENUM ('UNPAID', 'PAID', 'NOT_REQUIRED');

-- AlterTable
ALTER TABLE "Department"
ADD COLUMN "appealPaymentRequired" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "AppealLaborEntry" (
    "id" SERIAL NOT NULL,
    "appealId" INTEGER NOT NULL,
    "assigneeUserId" INTEGER NOT NULL,
    "hours" DECIMAL(8,2) NOT NULL DEFAULT 0.0,
    "paymentStatus" "AppealLaborPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "paidAt" TIMESTAMP(3),
    "paidById" INTEGER,
    "createdById" INTEGER NOT NULL,
    "updatedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppealLaborEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppealLaborEntry_appealId_assigneeUserId_key" ON "AppealLaborEntry"("appealId", "assigneeUserId");

-- CreateIndex
CREATE INDEX "AppealLaborEntry_assigneeUserId_paymentStatus_idx" ON "AppealLaborEntry"("assigneeUserId", "paymentStatus");

-- CreateIndex
CREATE INDEX "AppealLaborEntry_appealId_paymentStatus_idx" ON "AppealLaborEntry"("appealId", "paymentStatus");

-- CreateIndex
CREATE INDEX "Appeal_toDepartmentId_createdAt_idx" ON "Appeal"("toDepartmentId", "createdAt");

-- CreateIndex
CREATE INDEX "AppealStatusHistory_appealId_changedAt_idx" ON "AppealStatusHistory"("appealId", "changedAt");

-- AddForeignKey
ALTER TABLE "AppealLaborEntry" ADD CONSTRAINT "AppealLaborEntry_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "Appeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppealLaborEntry" ADD CONSTRAINT "AppealLaborEntry_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppealLaborEntry" ADD CONSTRAINT "AppealLaborEntry_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppealLaborEntry" ADD CONSTRAINT "AppealLaborEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppealLaborEntry" ADD CONSTRAINT "AppealLaborEntry_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
