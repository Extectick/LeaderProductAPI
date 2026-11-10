# Help: оптимизация чата и worker

Оптимизация от 05.11.2026 сохраняет существующие проверки доступа, личную
авторизацию 1С, lease задания, журнал событий и подтверждение передачи в IT.

## Приложение

- Компоненты сообщений получают стабильные обработчики. Новое состояние
  композера не пересоздаёт все строки списка; состояние отправляемых вложений
  вычисляется один раз на обновление исходных данных.
- Запасной диктофон опрашивается раз в 80 мс только во время записи. В простое
  нет опроса и связанных с ним обновлений React. Скрытая камера не измеряет
  свой viewport на каждом кадре.
- После подтверждённой синхронизации SQLite читает только изменённые сообщения
  и метаданные обращения в одной транзакции. Пустой список изменений не читает
  сообщения. Неизвестные, пропущенные или слишком большие подсказки вызывают
  полное восстановление. Web сохраняет прежнее JSON-хранилище.
- Глобальный cursor не подтверждает событие, пока синхронизация обращения не
  достигла его. Отзыв доступа отменяет применение уже начатого чтения; загрузка
  истории не возвращает пользователя к концу, если он успел прокрутить чат.

## API и worker

- Публикации одному обращению объединяют повторные wakeup; внутри пакета
  заменяются только промежуточные состояния того же сообщения. Финальные
  события сохраняются, cursor подтверждается после успешной отправки.
- Массовое прочтение выбирает кандидатов порциями по 100; уже подтверждённая
  позиция не запускает повторную пересборку ответа. Права и фактический cursor
  проверяются под прежней блокировкой обращения. Fanout ограничен четырьмя
  одновременными публикациями. Дубликаты `typing:false` подавляются на 700 мс.
- Символы `%`, `_` и `\` в поиске экранируются как литералы SQL LIKE.
- Подготовка изображений имеет общий бюджет 10 секунд. Зависший поток закрывается;
  локальный таймаут загрузки/декодирования изображения позволяет продолжить ответ
  без него. Отмена задания остаётся отменой. После I/O права источников повторно
  проверяются перед отправкой провайдеру.
- `HELP_AI_WORKER_CONCURRENCY` принимает целое от 1 до 4; default — 1. Каждый
  слот сохраняет независимый lease и heartbeat. Остановка отменяет и дожидается
  всех активных заданий. Увеличивать значение следует вместе с лимитами CPU/RAM.

## Два индекса чтения

Каноническая миграция: `20261105120000_help_read_indexes`. Добавляет индексы
`HelpAttachment(messageId, position)` и `HelpEvent(messageId, type)` без изменения
переписки. Не запускайте все накопленные миграции ради этих индексов.

Для действующего dev предназначен `scripts/apply-help-read-indexes.cjs`.
Он требует приватно заданный `DATABASE_URL` именно к `LeaderAPI_dev`,
`HELP_MIGRATION_TARGET=dev`, `HELP_MIGRATION_DATABASE_CONFIRM=LeaderAPI_dev`
и `DB_ACCEPT_DATA_LOSS=0`. Использует session advisory lock и отдельные
`CREATE INDEX CONCURRENTLY`; проверяет структуру обоих индексов и checksum в
`HelpSchemaVersion`. Повторный запуск только проверяет результат. Несовпадающие
или невалидные индексы не удаляются и не заменяются автоматически.

## Проверки

Релизный снимок APP без посторонней незавершённой Markdown-функции: 179 наборов,
1657 тестов; TypeScript. Полная рабочая APP: 180 наборов, 1661 тест; Expo Doctor
20/20 и `expo install --check`. API на проверенном снимке: 93 набора, 1004 теста,
TypeScript и сборка. Индексы: 8 Node-тестов и отдельная PostgreSQL 16 с 20 000
синтетических строк, проверкой partial resume, повторного запуска и отказов при
несовпадении схемы/checksum. Реальные пользовательские данные для тестов не нужны.

Проверки подтверждают уменьшение числа чтений, вызовов и перерисовок. FPS на
физическом Android не измерялся; длительность ответа модели не гарантируется.

## Активный dev

Оба процесса используют `leaderproductapi:help-performance-dev-20261105`,
слой над `help-dialogue31-recovery-dev-20261105`. Сохранены исправления 1С,
OpenAI, плоских имён OTA-ресурсов и прежние секреты/сети/тома. Изменены шесть
скомпилированных модулей Help; их SHA-256 проверены в API и worker. Оба процесса
healthy, публичный `/health` успешен, остальные контейнеры не пересоздавались.

В dev `HELP_AI_WORKER_CONCURRENCY=2`, worker ограничен 1 ГиБ RAM и 1 CPU.
Настройки находятся в worker-секции существующего приватного OpenAI binding;
при будущем выпуске сохранять порядок overlays. Глобальная маршрутизация и T3
не изменялись. Оба индекса применены online после проверенной резервной копии;
повторный запуск helper вернул `verified` без создания индексов. При откате
образа аддитивные индексы сохраняются; переписка из backup не восстанавливается.

APP: commit `db989666cdaf06561c5a55c46f676af7086d1d56` опубликован в `dev`,
OTA **0.1.46.6** для runtime `0.1.46`. Все 53 файла скачаны с проверкой хешей,
плоских имён и совместимости Hermes с текущим APK. Новая нативная сборка не нужна.
Metro работает с исходниками; посторонние незавершённые изменения в рабочей папке
не включены в релизный снимок оптимизации.

### IT wait / return to AI

An explicit confirmed IT request now persists a normal `SYSTEM` message linked
from `IT_REQUESTED`; joining IT persists `IT_JOINED`, with the real employee's
surname-first name and existing avatar. The existing batched event lookup adds
`itStatusChange` (`REQUESTED`, `JOINED`, `AI_RESUMED`) to message DTOs, preserving
history pagination and replay without schema changes.

`POST /help/tickets/:id/continue-ai` accepts an empty body, owner only, while OPEN,
AI is enabled, and no IT member has joined. It clears the request and persists an
`AI_RESUMED` row, without replaying an old prompt. The next owner message uses the
normal assistant path. Return and claim share the ticket advisory lock. Return after claim fails;
a specialist can still explicitly join an OPEN AI chat after the owner returns
to AI (see the lifecycle update below). New owner messages while
waiting return `HELP_WAITING_FOR_IT`; already committed idempotent retries still
return their receipt. Deferred obsolete IT request pushes are suppressed.

### IT lifecycle and closure feedback (2026-11-06)

A permitted specialist can now claim any OPEN Help ticket, without waiting for
`itRequested`. Claim still uses the ticket lock and `cancelHelpAssistant` to fence
in-flight AI output. Repeated claim creates no duplicate event. `leave-it` removes
only the caller's IT membership and records `IT_LEFT` (`itStatusChange: LEFT`).
If other IT members remain, AI stays paused. After the last one leaves, the next
owner message uses normal AI enqueue; leaving does not replay an earlier prompt.

`close-it` is limited to a joined specialist. It records a SYSTEM/TICKET_CLOSED
row with no fabricated rating. The owner sees `ticket.canRate` and can submit the
existing durable `/close` envelope once as feedback. This adds a CLOSURE message
and MESSAGE_CREATED event, preserving the original `closedAt` and 72-hour reopen
window. Repeated feedback with the same client ID returns the original receipt.
The owner may reopen without rating. New IT members expose authoritative
`itDisplayName` (surname then first name); JOINED/LEFT events keep their recorded
name stable. No schema migration or additional list-enrichment query is needed.


### Confirmed IT call notifications

Only `IT_REQUESTED` fans out to active `manage_help`/admin users, including inherited
and department roles, excluding the caller. Chat creation still updates the queue
but does not create notifications. Ordinary message/status banners are restricted
to the owner and real participants, so the initial user message cannot alert all
IT through the socket path either.

IT calls use `help-it-request` (HIGH, vibration `[0,250,200,250]`) and a bounded
`eventType` in the existing `HELP_MESSAGE` payload. Foreground vibration happens
only when the banner is actually presented or the visible chat handles the call;
socket/push/repeated callbacks share event deduplication. The global notification
switch remains respected; the ordinary new-message switch does not disable an IT
call. Revoked permissions, joined/cancelled calls and earlier AI-to-IT generations
cannot revive a queued alert. Previously queued `TICKET_CREATED` pushes are ignored.

Dev uses `HELP_EXPO_PROXY_URL` only through `help.push`: a separate Expo dispatcher
and restricted `exp.host:443` CONNECT gateway. Other push callers retain the default
transport, OpenAI retains its own gateway, and firewall/global routes are unchanged.
The gateway source is `deploy/help-expo-vpn-proxy.cjs`; local protocol tests are
`scripts/test_help_expo_vpn_proxy.cjs`. Native SDK/dependencies are unchanged.
An empty Expo receipt lookup tests connectivity without sending employee messages;
it does not prove physical-device vibration or downstream FCM display.


Dev rollout 2026-11-06: API and Help worker use
`leaderproductapi:help-it-lifecycle-dev-20261106-r2`, layered on the concurrently
released `help-it-notifications-dev-20261106-r1`. The latter already included the
reviewed service implementation; the final layer changes only Help routes.
Both processes are healthy and both loaded service/routes hashes were verified.
Notification delivery/proxy, provider/1C bindings and unrelated containers remain
unchanged. No schema migration is required. Nine checks on actual PostgreSQL
covered takeover, departure without immediate AI, next-message AI, closure,
idempotent feedback and reopening inside one rolled-back transaction; zero test
rows, provider calls or notifications remained. HTTP route checks and twelve
isolated runtime checks also passed.
