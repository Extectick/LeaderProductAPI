# Durable Help assistant and delivery

The assistant owns durable PostgreSQL jobs. HTTP accepts the user's message and
queues a job in the same transaction. The separate worker advances persisted
stages, holding a short lease per step; process loss leaves an expiring lease.
A fencing token and task revision prevent a stale or stopped attempt from
publishing. Corrections supersede the current progress row, keep its task ID and
input start sequence, and enqueue a successor below the new input.

Apply the reviewed migration `20261030110000_help_assistant_delivery` with the
normal deployment migration process before starting this code. An existing dev
installation managed by the scoped Help migration helper can instead run
`node scripts/apply-help-assistant-migration.cjs` with HELP_MIGRATION_TARGET=dev,
HELP_MIGRATION_DATABASE_CONFIRM matching the intended database, and
DB_ACCEPT_DATA_LOSS=0. It verifies the checksum and schema transactionally; it
never guesses the target. The original helper still verifies existing Help
schemas after this additive migration. Existing Help
messages remain valid; system authors/events now use nullable user IDs. DTOs
expose AI author ID 0 with role SYSTEM, and a persisted `assistantRun`.

## Explicit server simulator

Development/test only:

```
NODE_ENV=development
HELP_AI_ENABLED=true
HELP_AI_PROVIDER=simulator
HELP_AI_SIMULATOR_DURATION_MS=300000
```

Run the API normally and start a separate process:

```
npm run worker:help:dev
```

Compiled entry: `npm run worker:help`. Build with `npm run build` first.
No handset timer or open socket is needed for processing. The worker must keep
running while the handset is closed. A 5-minute scenario persists its next due
stage and resumes after worker restart. A configured simulator cannot activate
in production. The provider function seam is exported as `HelpAssistantProvider`;
no real external model or real credentials are configured by this change.

Stopping/retrying: POST `/help/tickets/:id/assistant/stop` or `/retry` with
`{runId}`. Only the owner controls an eligible open ticket; IT handoff/closure
cancels pending jobs. Repeated stop/retry cannot publish another final answer.
Progress produces ASSISTANT_UPDATED, finalization produces MESSAGE_CREATED in
the same transaction as the final text and notification outbox row. The final
uses the original progress message ID/sequence. Progress rows cannot advance
read receipts, so seeing progress never reads an answer that has not arrived.

## Synchronization

GET `/help/events?after=N` returns events, nextCursor, hasMore, resyncRequired,
snapshotCursor, visibleTicketIds and visibilityComplete. The account cursor
advances across inaccessible event IDs only at a repeatable-read high watermark.
Future/expired cursors request baseline reconciliation. The authoritative
visibility snapshot covers up to 10000 tickets; incomplete snapshots must not
revoke cached access by omission. Existing per-ticket `/sync` remains the source
of changed messages and tombstones. Clients must apply changes durably before
advancing their account cursor.

## Notification routing

A single account socket sends `help:presence` with `{sessionId,deviceId,active,
ticketId,pushToken?}` and a heartbeat every 15 seconds. Sessions expire after45s.
An optional pushToken is accepted only when registered to the authenticated user.
`help:notification-ack` (alias `help:notification:ack`) accepts `{eventId,sessionId,
kind:'chat'|'banner'}`; disposition is accepted as an alias of kind. ACK requires
an active, unexpired session on that socket; a chat ACK requires the exact ticket.

Presence alone never suppresses a push. Each notification has an ACK grace
window after live dispatch; a matching ACK suppresses only its device token.
Read messages suppress pending notification delivery globally. Foreground banner
preferences are separate from OS-push preferences. Push contains ticketId,
messageId and eventId; no provider/internal progress payload is included.

The dispatcher polls PostgreSQL every500ms. Each API replica dispatches journal
signals only to local authenticated user rooms; access is rechecked for the
recipients, including manager-role candidates. A per-notification PostgreSQL
advisory lock prevents overlapping replica push attempts. Per-token receipts
prevent retrying accepted devices when another device failed. Expo acceptance is
not proof of display/read. A process crash after provider acceptance but before
receipt commit can still cause a transport retry: client eventId deduplication
and the server's stable message identity are required; do not claim exactly-once
physical OS notification delivery.

Maintenance runs every6h: inactive session and ACK metadata older30days, completed
notification outboxes older30days, and completed task execution context older180days
are removed. User messages, drafts, queued/failed jobs, unsent notifications and
server events are retained. GET `/help/diagnostics` is available to authorized IT
managers and returns queue/error/exhausted-delivery counts and oldest pending
notification age without message text. Exhausted deliveries are retained for
operator investigation; an authorized IT manager can requeue one exhausted
notification with POST `/help/notifications/:id/retry` (empty body). Existing
accepted token receipts remain intact; no destructive dead-letter cleanup is performed.

## Optional local Docker simulator

`docker-compose.help-simulator.yml` merges with the existing local development
stack. It uses the same development image and `.env`/PostgreSQL connection as the
API, with a separate worker under the `help-simulator` profile. It is not an
override for `docker-compose.server-dev.yml` or a production stack.

Read-only validation (does not print resolved environment values):

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.help-simulator.yml --profile help-simulator config --quiet
```

When preparing a reviewed local dev launch, build the shared development image:

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.help-simulator.yml --profile help-simulator build api
```

The existing dev database must already have the base Help and attachment-preview
migrations. Apply the new assistant migration explicitly with the normal migration
process or this scoped helper. Set HELP_MIGRATION_DATABASE_CONFIRM in your shell
to the exact intended database name first; it is deliberately not inferred:

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.help-simulator.yml --profile help-simulator run --rm --no-deps -e HELP_MIGRATION_TARGET=dev -e HELP_MIGRATION_DATABASE_CONFIRM -e DB_ACCEPT_DATA_LOSS=0 api node scripts/apply-help-assistant-migration.cjs
```

After PostgreSQL/Redis are running and the explicit migration succeeds:

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.help-simulator.yml --profile help-simulator up -d --no-deps api help-assistant-worker
```

Both API and worker execute a read-only schema gate before starting; this override
removes the automatic `init-db.js` entry. Missing migration fails startup without
migrating, seeding or resetting anything. Source/scripts are mounted for local
development, and Prisma schema changes still require rebuilding the image.
Set HELP_AI_SIMULATOR_DURATION_MS=300000 for five minutes (default in the override)
or a shorter value for a focused check. The native QA fixture is a separate local
simulator: testing this server pipeline requires the real API-backed Help route.

Worker SIGTERM/SIGINT stops claiming new work, waits for the current step, closes
Prisma and the PostgreSQL pool, then exits. Docker grants75seconds and the worker
has a70second forced-exit deadline. Abrupt termination or an uncooperative future
provider leaves the fenced90second lease to expire, after which another worker
can recover the step without publishing a second final answer.

## Isolated server development deployment

The server-only override is `docker-compose.server-dev.help-simulator.yml`, merged
with `docker-compose.server-dev.yml` from the existing reviewed release directory.
The documented checkout is `/opt/leader-api-dev`; the Compose project is
`leader-api-dev`, its API listens on loopback3001, and PostgreSQL/Redis use their
own `postgres-dev`/`redis-dev` services. Preserve the running release's local
Compose changes and `.env` linkage, including any private integration host rules.
This override has no source mounts, requires an explicit reviewed local image tag
in HELP_SIMULATOR_IMAGE, and never pulls an inferred image automatically.

Use the existing backup procedure before migration: restrictive umask, pg_dump-Fc
of postgres-dev, nonempty backup check, and pg_restore--list verification. Derive
the dev database name from the existing postgres-dev POSTGRES_DB and explicitly
pass it as the scoped migration confirmation. Do not print resolved Compose
environments or connection strings.

After the reviewed image is built locally from the implementation, the commands
in that existing release directory are:

```sh
# HELP_SIMULATOR_IMAGE is already set to the reviewed image tag.
docker compose -f docker-compose.server-dev.yml -f docker-compose.server-dev.help-simulator.yml --profile help-simulator config --quiet
# dev_db is the explicitly verified existing postgres-dev database name.
docker compose -f docker-compose.server-dev.yml -f docker-compose.server-dev.help-simulator.yml --profile help-simulator run --rm --no-deps -e HELP_MIGRATION_TARGET=dev -e HELP_MIGRATION_DATABASE_CONFIRM="$dev_db" --entrypoint node api scripts/apply-help-assistant-migration.cjs
docker compose -f docker-compose.server-dev.yml -f docker-compose.server-dev.help-simulator.yml --profile help-simulator run --rm --no-deps --entrypoint node api scripts/verify-help-assistant-schema.cjs
docker compose -f docker-compose.server-dev.yml -f docker-compose.server-dev.help-simulator.yml --profile help-simulator up -d --no-deps api help-assistant-worker
```

The API and worker use the same reviewed image and same explicit dev database
connection. The worker has only the isolated dev default network and no listening
ports. Startup only checks the schema; no init-db, automatic migration, seed or
reset is run. Production services and the production database are not selected.

Once AI messages with nullable system authors exist, rollback must retain an
assistant-compatible reader. Stop the worker and disable HELP_AI_ENABLED while
keeping the compatible API image. A pre-assistant API/Prisma image cannot safely
read those new system-author rows. Do not remove answers or run a lossy down
migration merely to restore the old reader.
