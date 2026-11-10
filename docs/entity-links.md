# Объектные ссылки Help и личное чтение карточек

Контракт в `src/modules/entity-links/entity.contract.ts` задаёт версию URI и
идентичность: база + метаданные + GUID для 1С либо числовой APP ID профиля.
Из номера документа, представления и отдельного GUID без типа ссылка не строится.
Типы product/client-order являются представлениями реальных объектов 1С;
остальные поддержанные объекты открываются через generic представление.

`POST /entity-links/resolve` принимает `{target,maxTabularRows?:1..1000}` и
возвращает `{ok:true,data:EntityCardData}`. В ответе — поля, табличные части,
типизированные ссылки, заголовок и признаки усечения. По умолчанию100строк/ТЧ;
клиент может расширить просмотр. Неизвестный ответ MCP не выдаётся как пустая
успешная карточка. Секретные технические поля исключаются.

Роутер требует обычную авторизацию и статус пользователя, вызывает только
`userMcpCall(requesterId,baseKey,'get_object',...)` и проверяет личные proofs
перед выдачей. Нет общей учётной записи и дополнительных фильтров отдела/роли
для чтения бизнес-объекта. Складское зеркало и редактор заказов не подменяют
личный источник. Ошибка подключения возвращает422 и `connect_onec`; обычные
ошибки не раскрывают upstream body. Ответы имеют `private,no-store`, а роутер
подключён до body/debug/Kafka logging. Профиль APP использует существующий
`GET /users/:id/profile` и его прежнюю политику доступа.

## Ссылки для модели

`help.entity-links` ведёт каталог подтверждённых URL текущего запуска. Успешные
результаты1С получают отдельный sidecar `entityLinks`; исходный `data`, typedrefs
и proofs не изменяются. Ссылки берутся из фактических typedrefs и успешного
чтения объекта. Вызов последнего документа сохраняет `Док.Ссылка` и позволяет
сформировать ту же ссылку в проверенном серверном ответе.

`app_search_people` возвращает имена, APP ID и ссылки с существующим доступом
к профилям; телефоны, почта, логины и пароли не выдаются модели. Права повторно
проверяются. Новые URL в финале и видимых черновиках сверяются с каталогом;
неподтверждённые ссылки превращаются в обычную подпись. Ссылки прежних ответов
и прочитанной истории того же обращения могут использоваться повторно,
не выдавая исторические данные за свежее чтение.

Открытие ссылки всегда заново проверяет личный доступ и не предоставляет
разрешения на запись. Память обращения, source/lease/ticket fences, Office
и запрет генерации изображений/видео сохраняются. Миграций и новых зависимостей нет.

Dev scoped image: `leaderproductapi:help-entity-links-dev-20261105-r1` поверх
`help-office-dev-20261105-r2`. Индексный роутер добавлен в фактический runtime
index, остальные изменения ограничены десятью entity/Help модулями; полного
развёртывания грязной ветки не было. Приватные доказательства выпуска находятся
в `.dev-runtime/entity-links-20261105/` рабочей области.

## HTML-карточки: изображения реальных объектов

`POST /entity-links/preview` принимает строго `{target}` и возвращает
`{ok:true,data:{target,title,imageDataUrl?}}`. Авторизация, статус, отсутствие
публичного кэша и защищённое действие подключения1С общие с `/resolve`.
Этот запрос ничего не изменяет и не инициирует синхронизацию фотографий.

Профиль использует ту же self/employee/admin политику, что существующая страница
профиля; до выдачи картинки заново проверяются пользователь, доступ и текущий
avatar. Имя и ключ берутся из БД, URL модели не принимается. Разрешены ключи
текущего avatar prefix и пути настроенного собственного хранилища; удалённые
URL никогда не скачиваются. Картинка читается напрямую из S3 с лимитом2MiB,
проверяется как JPEG/PNG/WebP, поворачивается и преобразуется в WebP до512px
и180KiB. SVG, повреждённая, слишком большая или отсутствующая картинка даёт
отсутствующий `imageDataUrl`, а не поддельное фото. Токены и исходные S3ключи
в HTML и ответ preview не попадают.

Товар — только `Catalogs.Номенклатура`. Его название и доступ всегда
проверяются через личный `userMcpCall` и повторную проверку proof перед ответом.
Существующий ProductImage cache не имеет baseKey. Поэтому он используется
только при точном совпадении origin и пути публикации базы между серверным MCP
URL (`/<base>/hs/mcp/rpc`) и `ONEC_LP_APP_BASE_URL` (`/<base>/hs/lp-app`).
Другой хост/публикация или неизвестная связь означают отсутствие фотографии;
одинаковый GUID сам по себе не подтверждает источник. Для фото нужны SYNCED,
неудалённая запись и S3ключ в namespace именно данного товара; состояние
проверяется повторно после чтения. При нехватке доступа preview не возвращает
ни фото, ни успешные данные из зеркала.


## APP product cards — dev, 2026-11-05

The URI contract additionally accepts `{v:1,source:'app',kind:'product',guid}`
and `leaderproduct://entity/v1/product/<guid>`. These links open the stock
service's actual product card through exact GET /stock-balances/products/:guid.
The route retains stock service/auth/status/role permissions, current product
aggregation, images, balances and normal incoming-price refresh behavior.
Preview uses the same stock access policy and approved private synced images;
APP product preview never calls personal MCP.

Legacy Catalogs.Номенклатура links send their baseKey to the exact stock endpoint.
A matching origin/publication is accepted; explicit HELP_APP_PRODUCT_BASE_KEYS
(comma-separated, maximum20 known base keys) may select the application
projection for approved legacy bases. Dev explicitly binds torg2026. This is an
application-card mapping, not proof that personal MCP and app stock are the same
publication. GUID alone or a similar name cannot authorize a mapping. Unknown
bases return409 STOCK_SOURCE_MISMATCH; missing app products return404. There is
no silent personal-MCP or name-search fallback.

Request-local successful typed1C sidecars are promoted to APP product links only
after stock ACL and approved-base checks and exact existing Product GUID with
stock rows. Access is rechecked after lookup. Raw1C data/proofs are unchanged;
forged sidecars cannot register links. Existing policy/lease/context fences remain.

Scoped image help-app-product-cards-dev-20261105-r1 was deployed over actual
help-card-default-dev-20261105-r1 with eleven modules; later user-context rollout
retains the nine product/ACL/HTML modules byte-identically and extends the two
OpenAI modules. Both services healthy. Ticket54's existing milk link, exact
authorized200 / anonymous401 / foreign-base409 and real Sol/medium APP-link
generation were checked without editing the ticket or creating business writes.
Private proofs: .dev-runtime/help-product54/. No OTA/native/T3/Metro restart.


## Ссылки заказов — Metro/dev, 2026-11-06

Актуально06.11.2026. Владелец потребовал переиспользовать открытие из сервиса «Заказы клиентов». Сохранённые URI остаются прежними: leaderproduct://entity/v1/onec/<baseKey>/Documents/ЗаказКлиента/<guid>. Менять сообщения или мигрировать ссылки не требуется.

При разборе обращения77 выяснились две разные причины сбоя: generic get_object с полной табличной частью превышал лимит MCP; обычный клиентский сервис читает WMS15 через прежний Windows244 tunnel, а личная база torg2026 опубликована отдельно на192.168.30.54. Передавать GUID или ключ доступа из одной публикации в другую нельзя. Сам факт одинаковых GUID товаров или stock alias не подтверждает источник заказа. LPAPP в torg2026 запрашивает отдельный API-key; ключ WMS15 не пересылался, личный запрос не заменялся технической учёткой.

Исправленный контракт: GET /api/client-orders/:guid?baseKey=<configured-personal-base> читает именно личное сохранённое подключение сотрудника к указанной базе. Обычный GET без baseKey сохраняет прежнюю manager-scoped реализацию сервиса. Сервисные middleware client_orders/view_client_orders остаются. Неизвестная база не вызывает fallback в WMS15. Ошибки личной авторизации возвращают422 и connect_onec; пароль не передаётся в URL/модель/чат. Ответы qualifiedGET имеют private,no-store.

APIмодуль clientOrders.entity получает проверенную metadata-структуру ЗаказКлиента, запрашивает только разрешённые реквизиты и Товары через userMcpCall execute_query. Typed reference используется параметром; GUID и имена полей не исполняются как текстовые выражения. Header reference сверяется с точной базой/типом/GUID. COUNT подтверждает общее число строк; позиции читаются страницами10 до250, далее явный sourceTruncated/itemsTruncated. Комментарий ограничен2000символами с commentTruncated. Неполный или некорректный ответ, исчезнувшая страница и изменение доступа не становятся успешным пустым заказом. Права/connection proofs проверяются для каждого чтения и повторно вместе перед ответом. Цена/количество/сумма позиции принимаются только реальными конечными числами.

APP сохраняет sourceBaseKey от ссылки через preflight до маршрута /services/client_orders?orderGuid=...&orderBaseKey=... и повторного защищённого чтения. Для этого маршрута ClientOrderLinkedScreen не монтирует mutable workspace, списки, очереди, загрузку справочников или invoice-действия. Представление переиспользует HeaderSection, ItemsSection и LineItemCard из ClientOrdersMobileScreen. Отдельный readonly adapter сохраняет фактическую цену/сумму/валюту: legacy orderToDraft не должен превращать price в0 или валюту вRUB. Изображения и раскрытие ссылочных справочников другой публикации не подставляются. Смена аккаунта/базы, закрытие и выход отменяют поздние ответы; нужное личное подключение открывается защищённым ProfileOnecConnections.

Dev API/worker: leaderproductapi:help-order77-personal-dev-20261106-r2 — только2clientOrders JSмодуля поверх help-gateways-dev-20261106-r1. Существующие Help/1С/OpenAI/lease/ACL/OTA-модули и приватные Compose/env/mounts сохранены. Без миграций, новой зависимости, изменения1С, business writes, native rebuild или OTA. APP изменения применяются через текущий Metro.

Проверка: настоящий HTTP-запрос владельца обращения77 получил200 изtorg2026, точный документ, все11позиций, readOnly и private,no-store. Анонимный запрос401, неизвестная база404 безfallback, повторённыйbaseKey400. Исходное сообщение обращения не менялось. APIрегрессии и TypeScript прошли; APPпроверки и AndroidMetro проверяются отдельно. Бизнес-содержимое документа и учётные данные в эту инструкцию не включены.

При следующих полных APIсборках сохранять clientOrders.entity и новый qualifiedGET-handler. Source, минимальный runtime-layer и приватные доказательства находятся в рабочем каталоге .dev-runtime/help-order77; копия исходников для восстановления хранится в закрытой папке Nextcloud «Восстановление компании». Новые изменения знаний публиковать туда же согласно постоянному правилу владельца.
