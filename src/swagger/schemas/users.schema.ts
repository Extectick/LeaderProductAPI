// src/swagger/schemas/users.schema.ts
/**
 * Схемы OpenAPI (components.schemas) для модуля "Users".
 * Эти схемы описывают структуру поля "data" в ваших обёртках ApiSuccess/ApiError.
 * Используйте их в аннотациях через allOf + $ref, не меняя код обработчиков.
 */

const ProfileTypeEnum = {
  type: 'string',
  enum: ['CLIENT', 'SUPPLIER', 'EMPLOYEE'],
} as const;

const UserPublic = {
  type: 'object',
  required: ['id', 'email'],
  properties: {
    id: { type: 'integer', example: 15 },
    email: { type: 'string', format: 'email', example: 'user@example.com' },
    firstName: { type: 'string', nullable: true, example: 'Ivan' },
    lastName: { type: 'string', nullable: true, example: 'Ivanov' },
    middleName: { type: 'string', nullable: true, example: 'Ivanovich' },
    role: { type: 'string', nullable: true, example: 'admin' },
    currentProfileType: { ...ProfileTypeEnum, nullable: true },
  },
} as const;

const Address = {
  type: 'object',
  properties: {
    street: { type: 'string', example: 'Lenina, 10' },
    city: { type: 'string', example: 'Moscow' },
    state: { type: 'string', nullable: true, example: 'Moscow' },
    postalCode: { type: 'string', nullable: true, example: '101000' },
    country: { type: 'string', example: 'RU' },
  },
} as const;

const ClientProfile = {
  type: 'object',
  properties: {
    phone: { type: 'string', nullable: true, example: '+79990001122' },
    address: { ...Address, nullable: true },
  },
} as const;

const SupplierProfile = {
  type: 'object',
  properties: {
    phone: { type: 'string', nullable: true, example: '+79995556677' },
    address: { ...Address, nullable: true },
  },
} as const;

const EmployeeProfile = {
  type: 'object',
  properties: {
    phone: { type: 'string', nullable: true, example: '+79998887766' },
    department: { $ref: '#/components/schemas/DepartmentMini' }, // переиспользуем из appeals.schema.ts
  },
} as const;

/**
 * Универсальный профиль пользователя, возвращаемый /users/profile и /users/{id}/profile
 * Предусмотрены опциональные блоки profile.* в зависимости от типа.
 */
const UserProfile = {
  type: 'object',
  required: ['user'],
  properties: {
    user: UserPublic,
    type: ProfileTypeEnum, // алиас currentProfileType
    client: { ...ClientProfile, nullable: true },
    supplier: { ...SupplierProfile, nullable: true },
    employee: { ...EmployeeProfile, nullable: true },
  },
  example: {
    user: {
      id: 15,
      email: 'user@example.com',
      firstName: 'Ivan',
      lastName: 'Ivanov',
      currentProfileType: 'EMPLOYEE',
      role: 'admin',
    },
    type: 'EMPLOYEE',
    employee: { phone: '+79998887766', department: { id: 7, name: 'Support' } },
  },
} as const;

/** Универсальная «обёртка» с единственным сообщением в data */
const MessageOnly = {
  type: 'object',
  required: ['message'],
  properties: {
    message: { type: 'string', example: 'Операция выполнена' },
  },
} as const;

const usersSchemas = {
  ProfileTypeEnum,
  UserPublic,
  Address,
  ClientProfile,
  SupplierProfile,
  EmployeeProfile,
  UserProfile,
  MessageOnly,
} as const;

export default usersSchemas;
