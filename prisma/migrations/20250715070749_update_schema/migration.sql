/*
  Warnings:

  - You are about to drop the column `departmentId` on the `User` table. All the data in the column will be lost.
  - Changed the type of `action` on the `AuditLog` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "ProfileStatus" AS ENUM ('PENDING', 'ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'PASSWORD_RESET', 'EMAIL_VERIFICATION', 'OTHER');

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_departmentId_fkey";

-- AlterTable
ALTER TABLE "AuditLog" DROP COLUMN "action",
ADD COLUMN     "action" "ActionType" NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "departmentId",
ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "profileStatus" "ProfileStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "ClientProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "addressId" INTEGER,
    "phone" TEXT,
    "status" "ProfileStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "addressId" INTEGER,
    "phone" TEXT,
    "status" "ProfileStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "departmentId" INTEGER,
    "phone" TEXT,
    "status" "ProfileStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" SERIAL NOT NULL,
    "street" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_EmployeeDepartmentRoles" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_EmployeeDepartmentRoles_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientProfile_userId_key" ON "ClientProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProfile_userId_key" ON "SupplierProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeProfile_userId_key" ON "EmployeeProfile"("userId");

-- CreateIndex
CREATE INDEX "_EmployeeDepartmentRoles_B_index" ON "_EmployeeDepartmentRoles"("B");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- AddForeignKey
ALTER TABLE "ClientProfile" ADD CONSTRAINT "ClientProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientProfile" ADD CONSTRAINT "ClientProfile_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProfile" ADD CONSTRAINT "SupplierProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProfile" ADD CONSTRAINT "SupplierProfile_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeProfile" ADD CONSTRAINT "EmployeeProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeProfile" ADD CONSTRAINT "EmployeeProfile_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EmployeeDepartmentRoles" ADD CONSTRAINT "_EmployeeDepartmentRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "DepartmentRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EmployeeDepartmentRoles" ADD CONSTRAINT "_EmployeeDepartmentRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "EmployeeProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
