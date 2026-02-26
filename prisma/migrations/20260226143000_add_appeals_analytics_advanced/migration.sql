-- CreateEnum
CREATE TYPE "AppealFinancialFunnelStatus" AS ENUM ('NOT_PAYABLE', 'TO_PAY', 'PARTIAL', 'PAID');

-- AlterTable
ALTER TABLE "Department"
ADD COLUMN "appealLaborHourlyRate" DECIMAL(8,2) NOT NULL DEFAULT 1.0;

-- CreateTable
CREATE TABLE "AppealLaborAuditLog" (
    "id" SERIAL NOT NULL,
    "appealId" INTEGER NOT NULL,
    "assigneeUserId" INTEGER NOT NULL,
    "changedById" INTEGER NOT NULL,
    "oldHours" DECIMAL(8,2),
    "newHours" DECIMAL(8,2) NOT NULL,
    "oldPaymentStatus" "AppealLaborPaymentStatus",
    "newPaymentStatus" "AppealLaborPaymentStatus" NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppealLaborAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppealAnalyticsThreshold" (
    "id" SERIAL NOT NULL,
    "departmentId" INTEGER NOT NULL,
    "openTooLongHours" INTEGER NOT NULL DEFAULT 24,
    "resolvedTooLongHours" INTEGER NOT NULL DEFAULT 24,
    "laborMissingDays" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppealAnalyticsThreshold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppealLaborAuditLog_appealId_changedAt_idx" ON "AppealLaborAuditLog"("appealId", "changedAt");

-- CreateIndex
CREATE INDEX "AppealLaborAuditLog_assigneeUserId_changedAt_idx" ON "AppealLaborAuditLog"("assigneeUserId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppealAnalyticsThreshold_departmentId_key" ON "AppealAnalyticsThreshold"("departmentId");

-- CreateIndex
CREATE INDEX "AppealStatusHistory_newStatus_changedAt_idx" ON "AppealStatusHistory"("newStatus", "changedAt");

-- AddForeignKey
ALTER TABLE "AppealLaborAuditLog" ADD CONSTRAINT "AppealLaborAuditLog_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "Appeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppealLaborAuditLog" ADD CONSTRAINT "AppealLaborAuditLog_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppealLaborAuditLog" ADD CONSTRAINT "AppealLaborAuditLog_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppealAnalyticsThreshold" ADD CONSTRAINT "AppealAnalyticsThreshold_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
