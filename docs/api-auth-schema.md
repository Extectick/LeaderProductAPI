# API Schema Description

## Authentication

### POST /auth/login
Аутентификация пользователя по email и паролю.

**Пример запроса:**
```json
{
  "email": "user@example.com",
  "password": "secret123"
}
```

**Успешный ответ (200 OK):**
```json
{
  "accessToken": "JWT_ACCESS_TOKEN",
  "refreshToken": "JWT_REFRESH_TOKEN",
  "profile": {
    "id": 1,
    "email": "user@example.com",
    "firstName": "Иван",
    "lastName": "Иванов",
    "currentProfileType": "CLIENT", // или null
    "role": {
      "name": "user",
      "permissions": ["create_appeal", "view_products"]
    },
    "profileData": {
      "id": 1,
      "phone": "+79001234567",
      "status": "ACTIVE",
      "createdAt": "2025-07-16T10:00:00Z",
      "updatedAt": "2025-07-16T10:00:00Z"
    }
  }
}
```

**Ответ без активного профиля:**
```json
{
  "accessToken": "JWT_ACCESS_TOKEN",
  "refreshToken": "JWT_REFRESH_TOKEN",
  "profile": {
    "id": 1,
    "email": "user@example.com",
    "firstName": "Иван",
    "lastName": "Иванов",
    "currentProfileType": null,
    "role": {
      "name": "user",
      "permissions": ["create_appeal", "view_products"]
    },
    "profileData": null,
    "availableProfiles": {
      "clientProfile": { "id": 2, "status": "ACTIVE" },
      "supplierProfile": null,
      "employeeProfile": null
    }
  }
}
```

**Ошибки:**
- 401 — Неверные данные
- 403 — Аккаунт заблокирован или не активирован

...

## Остальные разделы

(Добавлены из предыдущего API schema — /users/profile, /users/me/department и т.д.)

## Примечания

- В ответ на логин могут возвращаться профили, если активный не выбран.
- Добавлена проверка блокировки аккаунта и профиля.
- Поддержка автоматической блокировки при множестве неудачных входов.