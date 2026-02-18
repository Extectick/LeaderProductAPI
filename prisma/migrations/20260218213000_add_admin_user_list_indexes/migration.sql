CREATE INDEX IF NOT EXISTS "User_currentProfileType_roleId_createdAt_idx"
  ON "User"("currentProfileType", "roleId", "createdAt");

CREATE INDEX IF NOT EXISTS "EmployeeProfile_status_departmentId_userId_idx"
  ON "EmployeeProfile"("status", "departmentId", "userId");
