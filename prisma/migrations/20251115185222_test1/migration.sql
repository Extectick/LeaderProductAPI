-- CreateEnum
CREATE TYPE "public"."RouteStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."RouteEventType" AS ENUM ('MOVE', 'STOP');

-- AlterEnum
ALTER TYPE "public"."AppealStatus" ADD VALUE 'RESOLVED';

-- CreateTable
CREATE TABLE "public"."UserRoute" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "public"."RouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RoutePoint" (
    "id" SERIAL NOT NULL,
    "routeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "eventType" "public"."RouteEventType" NOT NULL DEFAULT 'MOVE',
    "accuracy" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "stayDurationSeconds" INTEGER,
    "sequence" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutePoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserRoute_userId_startedAt_idx" ON "public"."UserRoute"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "RoutePoint_userId_recordedAt_idx" ON "public"."RoutePoint"("userId", "recordedAt");

-- CreateIndex
CREATE INDEX "RoutePoint_routeId_recordedAt_idx" ON "public"."RoutePoint"("routeId", "recordedAt");

-- AddForeignKey
ALTER TABLE "public"."UserRoute" ADD CONSTRAINT "UserRoute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoutePoint" ADD CONSTRAINT "RoutePoint_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "public"."UserRoute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoutePoint" ADD CONSTRAINT "RoutePoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
