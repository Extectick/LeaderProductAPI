-- Create permission groups table
CREATE TABLE "PermissionGroup" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "serviceId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PermissionGroup_key_key" ON "PermissionGroup"("key");
CREATE UNIQUE INDEX "PermissionGroup_serviceId_key" ON "PermissionGroup"("serviceId");
CREATE INDEX "PermissionGroup_sortOrder_idx" ON "PermissionGroup"("sortOrder");

-- Add optional group link to permissions
ALTER TABLE "Permission" ADD COLUMN "groupId" INTEGER;
CREATE INDEX "Permission_groupId_idx" ON "Permission"("groupId");

-- Foreign keys
ALTER TABLE "PermissionGroup"
ADD CONSTRAINT "PermissionGroup_serviceId_fkey"
FOREIGN KEY ("serviceId") REFERENCES "Service"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Permission"
ADD CONSTRAINT "Permission_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "PermissionGroup"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed system groups (idempotent by key)
INSERT INTO "PermissionGroup" ("key", "displayName", "description", "sortOrder", "isSystem", "serviceId")
VALUES
  ('core', 'Основные', 'Базовые права пользователя и общесистемные действия.', 10, true, NULL),
  ('admin', 'Администрирование', 'Управление пользователями, ролями, правами и настройками платформы.', 20, true, NULL),
  ('finance', 'Финансы', 'Права, связанные с финансовыми операциями и отчетностью.', 30, true, NULL),
  ('logistics', 'Логистика и склад', 'Права на работу с отгрузками и остатками.', 40, true, NULL),
  ('service_appeals', 'Сервис: Обращения', 'Права доступа к функциям сервиса обращений.', 100, true, (SELECT "id" FROM "Service" WHERE "key" = 'appeals' LIMIT 1)),
  ('service_qrcodes', 'Сервис: QR-коды', 'Права доступа к функциям сервиса QR-кодов.', 110, true, (SELECT "id" FROM "Service" WHERE "key" = 'qrcodes' LIMIT 1))
ON CONFLICT ("key") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "description" = EXCLUDED."description",
  "sortOrder" = EXCLUDED."sortOrder",
  "isSystem" = EXCLUDED."isSystem",
  "serviceId" = EXCLUDED."serviceId";

-- Backfill permission.groupId without overriding already assigned custom groups
UPDATE "Permission"
SET "groupId" = COALESCE(
  "groupId",
  (
    SELECT pg."id"
    FROM "PermissionGroup" pg
    WHERE pg."key" = CASE "Permission"."name"
      WHEN 'view_profile' THEN 'core'
      WHEN 'update_profile' THEN 'core'
      WHEN 'logout' THEN 'core'

      WHEN 'manage_roles' THEN 'admin'
      WHEN 'manage_permissions' THEN 'admin'
      WHEN 'assign_roles' THEN 'admin'
      WHEN 'assign_permissions' THEN 'admin'
      WHEN 'manage_users' THEN 'admin'
      WHEN 'manage_departments' THEN 'admin'
      WHEN 'manage_services' THEN 'admin'
      WHEN 'manage_updates' THEN 'admin'

      WHEN 'view_fin_reports' THEN 'finance'
      WHEN 'approve_payments' THEN 'finance'
      WHEN 'manage_payroll' THEN 'finance'

      WHEN 'view_shipments' THEN 'logistics'
      WHEN 'manage_shipments' THEN 'logistics'
      WHEN 'manage_inventory' THEN 'logistics'

      WHEN 'create_appeal' THEN 'service_appeals'
      WHEN 'view_appeal' THEN 'service_appeals'
      WHEN 'assign_appeal' THEN 'service_appeals'
      WHEN 'update_appeal_status' THEN 'service_appeals'
      WHEN 'add_appeal_message' THEN 'service_appeals'
      WHEN 'edit_appeal_message' THEN 'service_appeals'
      WHEN 'delete_appeal_message' THEN 'service_appeals'
      WHEN 'manage_appeal_watchers' THEN 'service_appeals'
      WHEN 'export_appeals' THEN 'service_appeals'

      WHEN 'create_qr' THEN 'service_qrcodes'
      WHEN 'update_qr' THEN 'service_qrcodes'
      WHEN 'delete_qr' THEN 'service_qrcodes'
      WHEN 'restore_qr' THEN 'service_qrcodes'
      WHEN 'view_qr' THEN 'service_qrcodes'
      WHEN 'view_qr_analytics' THEN 'service_qrcodes'
      WHEN 'view_qr_stats' THEN 'service_qrcodes'
      WHEN 'export_qr' THEN 'service_qrcodes'
      ELSE 'core'
    END
  )
);
