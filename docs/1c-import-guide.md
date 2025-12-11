# Инструкция по выгрузке данных из 1С:УТ 11 в API

## 1. Общие параметры
- Базовый путь: `https://<ваш-домен или ip>:3000/api/1c`
- Формат: `Content-Type: application/json`
- Аутентификация: поле `secret` в теле запроса. Значение должно совпадать с `ONEC_SECRET` в `.env` backend (см. `.env.dev/.env.production/.env.test`).

## 2. Порядок и эндпоинты
Вызывать батчи в любом нужном порядке, но рекомендуется:
1) Номенклатура (группы и товары)  
2) Склады  
3) Контрагенты с адресами  
4) Договор/соглашения/типы цен  
5) Спец‑цены  
6) Остатки

Эндпоинты:
- `POST /api/1c/nomenclature/batch`
- `POST /api/1c/warehouses/batch`
- `POST /api/1c/counterparties/batch`
- `POST /api/1c/agreements/batch`
- `POST /api/1c/special-prices/batch`
- `POST /api/1c/stock/batch`

## 3. Форматы тел запросов

### 3.1 Номенклатура (группы и товары)
`POST /api/1c/nomenclature/batch`
```json
{
  "secret": "ONEC_SECRET_VALUE",
  "items": [
    {
      "guid": "GUID_ГРУППЫ",
      "isGroup": true,
      "parentGuid": null,
      "name": "Морепродукты",
      "code": "0001",
      "isActive": true
    },
    {
      "guid": "GUID_ТОВАРА",
      "isGroup": false,
      "parentGuid": "GUID_ГРУППЫ",
      "name": "Лосось охлаждённый",
      "code": "0002",
      "article": "L001",
      "sku": "L001",
      "isWeight": false,
      "isService": false,
      "isActive": true,
      "baseUnit": { "guid": "GUID_ЕДИНИЦЫ", "name": "Килограмм", "code": "166", "symbol": "кг" },
      "packages": [
        {
          "guid": "GUID_УПАКОВКИ",
          "name": "Коробка 10 кг",
          "unit": { "guid": "GUID_ЕД_УПАКОВКИ", "name": "Коробка", "code": "xxx", "symbol": "кор" },
          "multiplier": 10,
          "barcode": "1234567890123",
          "isDefault": true,
          "sortOrder": 10
        }
      ]
    }
  ]
}
```
Логика: сперва upsert всех групп по `guid`, затем товаров (upsert по `guid`). Базовые единицы и единицы упаковок upsert по `guid`. Если `parentGuid` не найден, товар/группа создаётся без родителя (лог пишется).

### 3.2 Склады
`POST /api/1c/warehouses/batch`
```json
{
  "secret": "ONEC_SECRET_VALUE",
  "items": [
    { "guid": "GUID_СКЛАДА", "name": "Основной склад", "code": "00001", "isActive": true, "isDefault": false, "isPickup": false, "address": "г. Омск, ..." }
  ]
}
```
Upsert по `guid`.

### 3.3 Контрагенты и адреса
`POST /api/1c/counterparties/batch`
```json
{
  "secret": "ONEC_SECRET_VALUE",
  "items": [
    {
      "guid": "GUID_КОНТРАГЕНТА",
      "name": "ООО Ресторан",
      "fullName": "Общество ... «Ресторан»",
      "inn": "5500000000",
      "kpp": "550001001",
      "phone": "+7...",
      "email": "info@example.com",
      "isActive": true,
      "addresses": [
        {
          "guid": "GUID_АДРЕСА_1",
          "name": "Основной ресторан",
          "fullAddress": "г. Омск, ул. Ленина, д.1",
          "city": "Омск",
          "street": "Ленина",
          "house": "1",
          "building": null,
          "apartment": null,
          "postcode": "644000",
          "isDefault": true,
          "isActive": true
        }
      ]
    }
  ]
}
```
Upsert контрагента по `guid`. Адреса upsert по `guid` (если нет — create).

### 3.4 Договоры/соглашения/типы цен
`POST /api/1c/agreements/batch`
```json
{
  "secret": "ONEC_SECRET_VALUE",
  "items": [
    {
      "priceType": { "guid": "GUID_ТИПА_ЦЕН", "name": "Оптовая", "code": "OPT", "isActive": true },
      "contract": {
        "guid": "GUID_ДОГОВОРА",
        "counterpartyGuid": "GUID_КОНТРАГЕНТА",
        "number": "Д-001",
        "date": "2025-01-01T00:00:00Z",
        "validFrom": "2025-01-01T00:00:00Z",
        "validTo": null,
        "isActive": true,
        "comment": null
      },
      "agreement": {
        "guid": "GUID_СОГЛАШЕНИЯ",
        "name": "Соглашение интернет-заказы",
        "counterpartyGuid": "GUID_КОНТРАГЕНТА",
        "contractGuid": "GUID_ДОГОВОРА",
        "priceTypeGuid": "GUID_ТИПА_ЦЕН",
        "warehouseGuid": "GUID_СКЛАДА",
        "currency": "RUB",
        "isActive": true
      }
    }
  ]
}
```
Upsert типа цен (если блок `priceType` передан), договора по `guid`, соглашения по `guid` с привязками к контрагенту/договору/складу/типу цен по их `guid`.

### 3.5 Спец‑цены
`POST /api/1c/special-prices/batch`
```json
{
  "secret": "ONEC_SECRET_VALUE",
  "items": [
    {
      "guid": "GUID_СПЕЦЦЕНЫ",          // можно опустить/null — тогда будет использован композитный ключ
      "productGuid": "GUID_ТОВАРА",
      "counterpartyGuid": "GUID_КОНТРАГЕНТА",
      "agreementGuid": null,
      "priceTypeGuid": null,
      "price": 100.50,
      "currency": "RUB",
      "startDate": "2025-01-01T00:00:00Z",
      "endDate": null,
      "minQty": 10.0,
      "isActive": true
    }
  ]
}
```
При наличии `guid` — upsert по нему. Если `guid` нет, используется уникальный ключ `(productId, counterpartyId, agreementId, priceTypeId, startDate)`.

### 3.6 Остатки
`POST /api/1c/stock/batch`
```json
{
  "secret": "ONEC_SECRET_VALUE",
  "items": [
    {
      "productGuid": "GUID_ТОВАРА",
      "warehouseGuid": "GUID_СКЛАДА",
      "quantity": 123.456,
      "reserved": 10.000,
      "updatedAt": "2025-12-11T10:00:00Z"
    }
  ]
}
```
Upsert по паре `(productId, warehouseId)`. Если товар или склад не найдены по `guid`, строка помечается как ошибка в ответе.

## 4. Ответ API
Формат одинаков для всех батчей:
```json
{
  "success": true,
  "count": 10,
  "results": [
    { "key": "...", "status": "ok" },
    { "key": "...", "status": "error", "error": "..." }
  ]
}
```
`key` — обычно `guid` записи или комбинация полей (для остатков — `productGuid:warehouseGuid`).

## 5. Ошибки и валидация
- Валидация входа через Zod: на ошибки вернётся `400` и детали в `details`.
- Неверный `secret` → `401 Unauthorized`.
- Неожиданные ошибки → `500 Internal server error` (без стека в ответе, лог в stderr).

## 6. Подсказки по порядку и идентификаторам
- Все upsert’ы делаются по `guid`; убедитесь, что GUID из 1С стабильны.
- Для групп и товаров: сначала отправляйте все группы, затем товары.
- Для спец‑цен без `guid` используйте стабильный `startDate`, чтобы композитный ключ не дублировался.

Готово — можно настраивать обмен из 1С, формируя JSON по указанным шаблонам и отправляя батчами. Проверяйте ответы `results`, чтобы видеть, какие позиции приняли/отклонены.
