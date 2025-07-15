-- CreateEnum
CREATE TYPE "ProfileType" AS ENUM ('CLIENT', 'SUPPLIER', 'EMPLOYEE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "currentProfileType" "ProfileType";
