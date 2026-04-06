export type PermissionCatalogEntry = {
  name: string;
  displayName: string;
  description: string;
  groupKey: string;
};

export type PermissionGroupCatalogEntry = {
  key: string;
  displayName: string;
  description: string;
  sortOrder: number;
  isSystem: boolean;
  serviceKey?: string | null;
};

export const PERMISSION_GROUP_CATALOG: PermissionGroupCatalogEntry[] = [
  {
    key: 'core',
    displayName: 'Основные',
    description: 'Базовые права пользователя и общесистемные действия.',
    sortOrder: 10,
    isSystem: true,
    serviceKey: null,
  },
  {
    key: 'admin',
    displayName: 'Администрирование',
    description: 'Управление пользователями, ролями, правами и настройками платформы.',
    sortOrder: 20,
    isSystem: true,
    serviceKey: null,
  },
  {
    key: 'finance',
    displayName: 'Финансы',
    description: 'Права, связанные с финансовыми операциями и отчётностью.',
    sortOrder: 30,
    isSystem: true,
    serviceKey: null,
  },
  {
    key: 'logistics',
    displayName: 'Логистика и склад',
    description: 'Права на работу с отгрузками и остатками.',
    sortOrder: 40,
    isSystem: true,
    serviceKey: null,
  },
  {
    key: 'service_appeals',
    displayName: 'Сервис: Обращения',
    description: 'Права доступа к функциям сервиса обращений.',
    sortOrder: 100,
    isSystem: true,
    serviceKey: 'appeals',
  },
  {
    key: 'service_qrcodes',
    displayName: 'Сервис: QR-коды',
    description: 'Права доступа к функциям сервиса QR-кодов.',
    sortOrder: 110,
    isSystem: true,
    serviceKey: 'qrcodes',
  },
  {
    key: 'service_stock_balances',
    displayName: 'Сервис: Остатки по складам',
    description: 'Права доступа к просмотру остатков по складам.',
    sortOrder: 120,
    isSystem: true,
    serviceKey: 'stock_balances',
  },
  {
    key: 'service_client_orders',
    displayName: 'Сервис: Заказы клиентов',
    description: 'Права доступа к менеджерскому сервису заказов клиентов.',
    sortOrder: 130,
    isSystem: true,
    serviceKey: 'client_orders',
  },
];

export const PERMISSION_CATALOG: PermissionCatalogEntry[] = [
  { name: 'view_profile', displayName: 'Просмотр профиля', description: 'Разрешает просматривать профиль пользователя.', groupKey: 'core' },
  { name: 'update_profile', displayName: 'Редактирование профиля', description: 'Разрешает изменять данные собственного профиля.', groupKey: 'core' },
  { name: 'logout', displayName: 'Выход из системы', description: 'Разрешает завершать текущую сессию пользователя.', groupKey: 'core' },

  { name: 'manage_roles', displayName: 'Управление ролями', description: 'Разрешает создавать, изменять и удалять роли.', groupKey: 'admin' },
  { name: 'manage_permissions', displayName: 'Управление правами', description: 'Разрешает изменять набор прав у ролей и просматривать список прав.', groupKey: 'admin' },
  { name: 'assign_roles', displayName: 'Назначение ролей', description: 'Разрешает назначать пользователям основные роли.', groupKey: 'admin' },
  { name: 'assign_permissions', displayName: 'Назначение прав', description: 'Разрешает назначать права ролям.', groupKey: 'admin' },
  { name: 'manage_users', displayName: 'Управление пользователями', description: 'Разрешает управлять данными и статусами пользователей.', groupKey: 'admin' },
  { name: 'manage_departments', displayName: 'Управление отделами', description: 'Разрешает создавать и изменять отделы и их состав.', groupKey: 'admin' },
  { name: 'manage_services', displayName: 'Управление сервисами', description: 'Разрешает настраивать доступность сервисов по ролям и отделам.', groupKey: 'admin' },
  { name: 'manage_updates', displayName: 'Управление обновлениями', description: 'Разрешает публиковать и администрировать обновления приложения.', groupKey: 'admin' },

  { name: 'view_fin_reports', displayName: 'Просмотр финансовых отчётов', description: 'Разрешает просматривать финансовую отчётность.', groupKey: 'finance' },
  { name: 'approve_payments', displayName: 'Согласование платежей', description: 'Разрешает подтверждать и согласовывать платежи.', groupKey: 'finance' },
  { name: 'manage_payroll', displayName: 'Управление зарплатами', description: 'Разрешает управлять расчётом и выплатами зарплат.', groupKey: 'finance' },
  { name: 'view_shipments', displayName: 'Просмотр отгрузок', description: 'Разрешает просматривать информацию по отгрузкам.', groupKey: 'logistics' },
  { name: 'manage_shipments', displayName: 'Управление отгрузками', description: 'Разрешает создавать и изменять отгрузки.', groupKey: 'logistics' },
  { name: 'manage_inventory', displayName: 'Управление складом', description: 'Разрешает управлять остатками и складскими операциями.', groupKey: 'logistics' },

  { name: 'create_appeal', displayName: 'Создание обращений', description: 'Разрешает создавать новые обращения.', groupKey: 'service_appeals' },
  { name: 'view_appeal', displayName: 'Просмотр обращений', description: 'Разрешает просматривать обращения и их детали.', groupKey: 'service_appeals' },
  { name: 'assign_appeal', displayName: 'Назначение по обращениям', description: 'Разрешает назначать исполнителей и брать обращения в работу.', groupKey: 'service_appeals' },
  { name: 'update_appeal_status', displayName: 'Смена статуса обращения', description: 'Разрешает менять статус обращения.', groupKey: 'service_appeals' },
  { name: 'add_appeal_message', displayName: 'Добавление сообщений в обращение', description: 'Разрешает писать сообщения в обращении.', groupKey: 'service_appeals' },
  { name: 'edit_appeal_message', displayName: 'Редактирование сообщений обращения', description: 'Разрешает редактировать сообщения в обращении.', groupKey: 'service_appeals' },
  { name: 'delete_appeal_message', displayName: 'Удаление сообщений обращения', description: 'Разрешает удалять сообщения в обращении.', groupKey: 'service_appeals' },
  { name: 'manage_appeal_watchers', displayName: 'Управление наблюдателями обращения', description: 'Разрешает изменять список наблюдателей обращения.', groupKey: 'service_appeals' },
  { name: 'export_appeals', displayName: 'Экспорт обращений', description: 'Разрешает экспортировать обращения и отчёты по ним.', groupKey: 'service_appeals' },
  { name: 'view_appeals_analytics', displayName: 'Просмотр аналитики обращений', description: 'Разрешает просматривать аналитику по обращениям и исполнителям.', groupKey: 'service_appeals' },
  { name: 'manage_appeal_labor', displayName: 'Управление трудозатратами обращения', description: 'Разрешает проставлять часы и статусы оплаты по исполнителям обращения.', groupKey: 'service_appeals' },

  { name: 'create_qr', displayName: 'Создание QR', description: 'Разрешает создавать QR-коды.', groupKey: 'service_qrcodes' },
  { name: 'update_qr', displayName: 'Редактирование QR', description: 'Разрешает изменять QR-коды.', groupKey: 'service_qrcodes' },
  { name: 'delete_qr', displayName: 'Удаление QR', description: 'Разрешает удалять QR-коды.', groupKey: 'service_qrcodes' },
  { name: 'restore_qr', displayName: 'Восстановление QR', description: 'Разрешает восстанавливать удалённые QR-коды.', groupKey: 'service_qrcodes' },
  { name: 'view_qr', displayName: 'Просмотр QR', description: 'Разрешает просматривать QR-коды.', groupKey: 'service_qrcodes' },
  { name: 'view_qr_analytics', displayName: 'Просмотр аналитики QR', description: 'Разрешает смотреть аналитику по сканам QR-кодов.', groupKey: 'service_qrcodes' },
  { name: 'view_qr_stats', displayName: 'Просмотр статистики QR', description: 'Разрешает просматривать статистические сводки QR.', groupKey: 'service_qrcodes' },
  { name: 'export_qr', displayName: 'Экспорт QR', description: 'Разрешает экспортировать данные по QR-кодам.', groupKey: 'service_qrcodes' },

  { name: 'view_stock_balances', displayName: 'Просмотр остатков по складам', description: 'Разрешает просматривать остатки по складам, организациям и сериям.', groupKey: 'service_stock_balances' },
  { name: 'view_client_orders', displayName: 'Просмотр заказов клиентов', description: 'Разрешает просматривать менеджерские заказы клиентов и их статус синхронизации.', groupKey: 'service_client_orders' },
  { name: 'manage_client_orders', displayName: 'Управление заказами клиентов', description: 'Разрешает создавать, редактировать, отправлять и отменять заказы клиентов.', groupKey: 'service_client_orders' },
];

export const PERMISSION_CATALOG_BY_NAME = new Map(
  PERMISSION_CATALOG.map((entry) => [entry.name, entry])
);

export const PERMISSION_GROUP_CATALOG_BY_KEY = new Map(
  PERMISSION_GROUP_CATALOG.map((entry) => [entry.key, entry])
);

export const DEFAULT_PERMISSION_GROUP_KEY = 'core';

export const DEFAULT_SERVICE_PERMISSION_ACTIONS = ['view', 'create', 'update', 'delete', 'export'];

export const SERVICE_PERMISSION_ACTION_LABELS: Record<string, string> = {
  view: 'Просмотр',
  create: 'Создание',
  update: 'Редактирование',
  delete: 'Удаление',
  export: 'Экспорт',
};

export const DEFAULT_ROLE_DISPLAY_NAMES: Record<string, string> = {
  user: 'Пользователь',
  employee: 'Сотрудник',
  department_manager: 'Руководитель отдела',
  admin: 'Администратор',
};

export const SYSTEM_ROLE_NAMES = new Set<string>(Object.keys(DEFAULT_ROLE_DISPLAY_NAMES));

export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  user: ['view_profile', 'update_profile', 'logout'],
  employee: [
    'create_appeal',
    'view_appeal',
    'add_appeal_message',
    'edit_appeal_message',
    'delete_appeal_message',
    'manage_appeal_watchers',
    'view_stock_balances',
    'view_client_orders',
  ],
  department_manager: [
    'assign_appeal',
    'update_appeal_status',
    'export_appeals',
    'view_appeals_analytics',
    'manage_appeal_labor',
    'view_client_orders',
    'manage_client_orders',
  ],
};
