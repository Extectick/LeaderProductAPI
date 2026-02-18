-- Add RBAC metadata columns
ALTER TABLE "Role" ADD COLUMN "displayName" TEXT;
ALTER TABLE "Permission" ADD COLUMN "displayName" TEXT;
ALTER TABLE "Permission" ADD COLUMN "description" TEXT;

-- Backfill role display names
UPDATE "Role"
SET "displayName" = CASE "name"
  WHEN 'user' THEN 'Пользователь'
  WHEN 'employee' THEN 'Сотрудник'
  WHEN 'department_manager' THEN 'Руководитель отдела'
  WHEN 'admin' THEN 'Администратор'
  ELSE "name"
END
WHERE "displayName" IS NULL;

-- Backfill permission display names and descriptions
UPDATE "Permission"
SET
  "displayName" = CASE "name"
    WHEN 'view_profile' THEN 'Просмотр профиля'
    WHEN 'update_profile' THEN 'Редактирование профиля'
    WHEN 'logout' THEN 'Выход из системы'
    WHEN 'manage_roles' THEN 'Управление ролями'
    WHEN 'manage_permissions' THEN 'Управление правами'
    WHEN 'assign_roles' THEN 'Назначение ролей'
    WHEN 'assign_permissions' THEN 'Назначение прав'
    WHEN 'manage_users' THEN 'Управление пользователями'
    WHEN 'manage_departments' THEN 'Управление отделами'
    WHEN 'manage_services' THEN 'Управление сервисами'
    WHEN 'manage_updates' THEN 'Управление обновлениями'
    WHEN 'view_fin_reports' THEN 'Просмотр финансовых отчётов'
    WHEN 'approve_payments' THEN 'Согласование платежей'
    WHEN 'manage_payroll' THEN 'Управление зарплатами'
    WHEN 'view_shipments' THEN 'Просмотр отгрузок'
    WHEN 'manage_shipments' THEN 'Управление отгрузками'
    WHEN 'manage_inventory' THEN 'Управление складом'
    WHEN 'create_appeal' THEN 'Создание обращений'
    WHEN 'view_appeal' THEN 'Просмотр обращений'
    WHEN 'assign_appeal' THEN 'Назначение по обращениям'
    WHEN 'update_appeal_status' THEN 'Смена статуса обращения'
    WHEN 'add_appeal_message' THEN 'Добавление сообщений в обращение'
    WHEN 'edit_appeal_message' THEN 'Редактирование сообщений обращения'
    WHEN 'delete_appeal_message' THEN 'Удаление сообщений обращения'
    WHEN 'manage_appeal_watchers' THEN 'Управление наблюдателями обращения'
    WHEN 'export_appeals' THEN 'Экспорт обращений'
    WHEN 'create_qr' THEN 'Создание QR'
    WHEN 'update_qr' THEN 'Редактирование QR'
    WHEN 'delete_qr' THEN 'Удаление QR'
    WHEN 'restore_qr' THEN 'Восстановление QR'
    WHEN 'view_qr' THEN 'Просмотр QR'
    WHEN 'view_qr_analytics' THEN 'Просмотр аналитики QR'
    WHEN 'view_qr_stats' THEN 'Просмотр статистики QR'
    WHEN 'export_qr' THEN 'Экспорт QR'
    ELSE "name"
  END,
  "description" = CASE "name"
    WHEN 'view_profile' THEN 'Разрешает просматривать профиль пользователя.'
    WHEN 'update_profile' THEN 'Разрешает изменять данные собственного профиля.'
    WHEN 'logout' THEN 'Разрешает завершать текущую сессию пользователя.'
    WHEN 'manage_roles' THEN 'Разрешает создавать, изменять и удалять роли.'
    WHEN 'manage_permissions' THEN 'Разрешает изменять набор прав у ролей и просматривать список прав.'
    WHEN 'assign_roles' THEN 'Разрешает назначать пользователям основные роли.'
    WHEN 'assign_permissions' THEN 'Разрешает назначать права ролям.'
    WHEN 'manage_users' THEN 'Разрешает управлять данными и статусами пользователей.'
    WHEN 'manage_departments' THEN 'Разрешает создавать и изменять отделы и их состав.'
    WHEN 'manage_services' THEN 'Разрешает настраивать доступность сервисов по ролям и отделам.'
    WHEN 'manage_updates' THEN 'Разрешает публиковать и администрировать обновления приложения.'
    WHEN 'view_fin_reports' THEN 'Разрешает просматривать финансовую отчётность.'
    WHEN 'approve_payments' THEN 'Разрешает подтверждать и согласовывать платежи.'
    WHEN 'manage_payroll' THEN 'Разрешает управлять расчётом и выплатами зарплат.'
    WHEN 'view_shipments' THEN 'Разрешает просматривать информацию по отгрузкам.'
    WHEN 'manage_shipments' THEN 'Разрешает создавать и изменять отгрузки.'
    WHEN 'manage_inventory' THEN 'Разрешает управлять остатками и складскими операциями.'
    WHEN 'create_appeal' THEN 'Разрешает создавать новые обращения.'
    WHEN 'view_appeal' THEN 'Разрешает просматривать обращения и их детали.'
    WHEN 'assign_appeal' THEN 'Разрешает назначать исполнителей и брать обращения в работу.'
    WHEN 'update_appeal_status' THEN 'Разрешает менять статус обращения.'
    WHEN 'add_appeal_message' THEN 'Разрешает писать сообщения в обращении.'
    WHEN 'edit_appeal_message' THEN 'Разрешает редактировать сообщения в обращении.'
    WHEN 'delete_appeal_message' THEN 'Разрешает удалять сообщения в обращении.'
    WHEN 'manage_appeal_watchers' THEN 'Разрешает изменять список наблюдателей обращения.'
    WHEN 'export_appeals' THEN 'Разрешает экспортировать обращения и отчёты по ним.'
    WHEN 'create_qr' THEN 'Разрешает создавать QR-коды.'
    WHEN 'update_qr' THEN 'Разрешает изменять QR-коды.'
    WHEN 'delete_qr' THEN 'Разрешает удалять QR-коды.'
    WHEN 'restore_qr' THEN 'Разрешает восстанавливать удалённые QR-коды.'
    WHEN 'view_qr' THEN 'Разрешает просматривать QR-коды.'
    WHEN 'view_qr_analytics' THEN 'Разрешает смотреть аналитику по сканам QR-кодов.'
    WHEN 'view_qr_stats' THEN 'Разрешает просматривать статистические сводки QR.'
    WHEN 'export_qr' THEN 'Разрешает экспортировать данные по QR-кодам.'
    ELSE ''
  END
WHERE "displayName" IS NULL OR "description" IS NULL;

ALTER TABLE "Role" ALTER COLUMN "displayName" SET NOT NULL;
ALTER TABLE "Permission" ALTER COLUMN "displayName" SET NOT NULL;
ALTER TABLE "Permission" ALTER COLUMN "description" SET NOT NULL;

