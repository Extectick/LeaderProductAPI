ALTER TABLE "EmployeeProfile"
  ADD COLUMN IF NOT EXISTS "onecUserGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "onecPhysicalPersonGuid" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeProfile_onecUserGuid_key"
  ON "EmployeeProfile"("onecUserGuid");

CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeProfile_onecPhysicalPersonGuid_key"
  ON "EmployeeProfile"("onecPhysicalPersonGuid");

INSERT INTO "Service" (
  "key",
  "name",
  "kind",
  "route",
  "icon",
  "description",
  "gradientStart",
  "gradientEnd",
  "isActive",
  "defaultVisible",
  "defaultEnabled",
  "createdAt",
  "updatedAt"
)
VALUES (
  'transport_tasks',
  'Задания на перевозку',
  'CLOUD',
  '/services/transport_tasks',
  'map-outline',
  'Задания на перевозку и порядок точек маршрута из 1С.',
  '#0F766E',
  '#2563EB',
  true,
  true,
  true,
  NOW(),
  NOW()
)
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "kind" = EXCLUDED."kind",
  "route" = EXCLUDED."route",
  "icon" = EXCLUDED."icon",
  "description" = EXCLUDED."description",
  "gradientStart" = EXCLUDED."gradientStart",
  "gradientEnd" = EXCLUDED."gradientEnd",
  "isActive" = EXCLUDED."isActive",
  "defaultVisible" = EXCLUDED."defaultVisible",
  "defaultEnabled" = EXCLUDED."defaultEnabled",
  "updatedAt" = NOW();

INSERT INTO "PermissionGroup" (
  "key",
  "displayName",
  "description",
  "sortOrder",
  "isSystem",
  "serviceId",
  "createdAt",
  "updatedAt"
)
VALUES (
  'service_transport_tasks',
  'Сервис: Задания на перевозку',
  'Права доступа к заданиям на перевозку из 1С.',
  140,
  true,
  (SELECT "id" FROM "Service" WHERE "key" = 'transport_tasks' LIMIT 1),
  NOW(),
  NOW()
)
ON CONFLICT ("key") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "description" = EXCLUDED."description",
  "sortOrder" = EXCLUDED."sortOrder",
  "isSystem" = EXCLUDED."isSystem",
  "serviceId" = EXCLUDED."serviceId",
  "updatedAt" = NOW();

INSERT INTO "Permission" ("name", "displayName", "description", "groupId")
VALUES
  (
    'view_transport_tasks',
    'Просмотр заданий на перевозку',
    'Разрешает просматривать задания на перевозку из 1С.',
    (SELECT "id" FROM "PermissionGroup" WHERE "key" = 'service_transport_tasks' LIMIT 1)
  ),
  (
    'update_transport_route_order',
    'Изменение порядка маршрута',
    'Разрешает сохранять новый порядок точек маршрута задания на перевозку.',
    (SELECT "id" FROM "PermissionGroup" WHERE "key" = 'service_transport_tasks' LIMIT 1)
  ),
  (
    'manage_transport_tasks',
    'Управление заданиями на перевозку',
    'Разрешает смотреть задания других водителей и управлять привязками к 1С.',
    (SELECT "id" FROM "PermissionGroup" WHERE "key" = 'service_transport_tasks' LIMIT 1)
  )
ON CONFLICT ("name") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "description" = EXCLUDED."description",
  "groupId" = EXCLUDED."groupId";

INSERT INTO "RolePermissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."name" IN ('view_transport_tasks', 'update_transport_route_order')
WHERE r."name" = 'employee'
ON CONFLICT DO NOTHING;

INSERT INTO "RolePermissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."name" = 'manage_transport_tasks'
WHERE r."name" = 'department_manager'
ON CONFLICT DO NOTHING;

INSERT INTO "RolePermissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."name" IN (
  'view_transport_tasks',
  'update_transport_route_order',
  'manage_transport_tasks'
)
WHERE r."name" = 'admin'
ON CONFLICT DO NOTHING;
