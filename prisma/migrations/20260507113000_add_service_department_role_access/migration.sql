CREATE TABLE "ServiceDepartmentRoleAccess" (
    "id" SERIAL NOT NULL,
    "serviceId" INTEGER NOT NULL,
    "departmentId" INTEGER NOT NULL,
    "roleId" INTEGER NOT NULL,
    "visible" BOOLEAN,
    "enabled" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceDepartmentRoleAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServiceDepartmentRoleAccess_serviceId_departmentId_roleId_key"
ON "ServiceDepartmentRoleAccess"("serviceId", "departmentId", "roleId");

CREATE INDEX "ServiceDepartmentRoleAccess_departmentId_roleId_idx"
ON "ServiceDepartmentRoleAccess"("departmentId", "roleId");

CREATE INDEX "ServiceDepartmentRoleAccess_roleId_idx"
ON "ServiceDepartmentRoleAccess"("roleId");

ALTER TABLE "ServiceDepartmentRoleAccess"
ADD CONSTRAINT "ServiceDepartmentRoleAccess_serviceId_fkey"
FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServiceDepartmentRoleAccess"
ADD CONSTRAINT "ServiceDepartmentRoleAccess_departmentId_fkey"
FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServiceDepartmentRoleAccess"
ADD CONSTRAINT "ServiceDepartmentRoleAccess_roleId_fkey"
FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
