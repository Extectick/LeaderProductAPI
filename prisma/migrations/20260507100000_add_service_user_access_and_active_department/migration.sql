ALTER TABLE "EmployeeProfile"
ADD COLUMN "activeDepartmentId" INTEGER;

UPDATE "EmployeeProfile"
SET "activeDepartmentId" = "departmentId"
WHERE "activeDepartmentId" IS NULL;

CREATE INDEX "EmployeeProfile_activeDepartmentId_idx"
ON "EmployeeProfile"("activeDepartmentId");

ALTER TABLE "EmployeeProfile"
ADD CONSTRAINT "EmployeeProfile_activeDepartmentId_fkey"
FOREIGN KEY ("activeDepartmentId") REFERENCES "Department"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServiceUserAccess" (
    "id" SERIAL NOT NULL,
    "serviceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "visible" BOOLEAN,
    "enabled" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceUserAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServiceUserAccess_serviceId_userId_key"
ON "ServiceUserAccess"("serviceId", "userId");

CREATE INDEX "ServiceUserAccess_userId_idx"
ON "ServiceUserAccess"("userId");

ALTER TABLE "ServiceUserAccess"
ADD CONSTRAINT "ServiceUserAccess_serviceId_fkey"
FOREIGN KEY ("serviceId") REFERENCES "Service"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServiceUserAccess"
ADD CONSTRAINT "ServiceUserAccess_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
