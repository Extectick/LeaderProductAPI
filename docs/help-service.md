# Help service, first real release (AI disabled)

This module is independent of Appeals. PostgreSQL is authoritative; Socket.IO is a notification transport, and clients repair their snapshots through REST/replay after reconnect. It does not invoke OpenAI, MCP, transcription or simulated assistant answers. The title is a bounded excerpt of the first message, not an AI-generated title.

## Access

Every REST operation and socket subscription/delivery resolves the current `help` service access, active user and block state. A normal employee can access only owned tickets. IT queue access requires the current `manage_help` permission (including inherited/current department roles) or the existing administrator role. No broad employee role receives this permission automatically. IT must claim a ticket before sending messages. Several IT specialists may claim the same ticket. Revoking their IT permission also revokes access through an old IT membership.

The additive migration registers the service and permission; administrators configure the pilot IT roles through the existing access administration. Generic Socket.IO `join` cannot join `help:*`; Help sends only after per-recipient ACL checks. Tokens expiring during a live connection cannot continue receiving Help updates.

## REST contract

All routes are under `/help`, require a Bearer access token and return plain JSON (not a `data` wrapper). Errors carry `{code,message}` and an appropriate HTTP status. Responses are `private, no-store`.

- `GET /config`: `aiEnabled:false`, `canManage`, upload limits.
- `GET /tickets?status=OPEN|CLOSED&scope=mine|queue&cursor=id&q=text`: `{tickets,nextCursor}` (50 per page). Optional `q` (up to 100 characters) searches the full authorized history by title, numeric ticket number or message text, case-insensitively.
- `POST /tickets`: `{clientTicketId,clientMessageId,text,attachmentIds?,sourceTicketId?}`. Creates the ticket only with a first message. Repeated keys replay the stored result; a changed request with the same identity returns 409.
- `GET /tickets/:id`: `{ticket,messages}`; latest 100 messages in chronological order.
- `GET /tickets/:id/messages?before=sequence`: older history, `{messages,nextCursor}`.
- `POST /tickets/:id/messages`: `{clientMessageId,text,attachmentIds?,replyToId?,forwardedFromId?}`.
- `PATCH /messages/:id`: `{text,rating?,attachmentIds?}`. Own message only, less than one hour old. Omitted attachment IDs preserve existing attachments; supplied IDs replace the set using existing files or the author's unbound uploads. Removed files become private unbound files, not public or deleted.
- `PUT|DELETE /messages/:id/reactions/:emoji`: independent reactions with one row per message/user/emoji. Several different reactions are permitted.
- `POST /tickets/:id/close`: `{clientMessageId,text?,rating?:0..5,attachmentIds?}`. Owner only. Empty text and zero stars are valid; a separate closure message is persisted.
- `POST /tickets/:id/reopen`: `{clientMessageId,text,attachmentIds?}`. Owner only, nonempty explanation, within 72 hours since the latest closure. After the deadline the user creates a new ticket with `sourceTicketId`.
- `POST /tickets/:id/request-it` and `/claim`: support request/self-assignment.
- `POST /tickets/:id/read`: `{sequence?}`; monotonic read cursor and no event on a no-op. `POST /read-all` reads the caller's member tickets.
- `POST /attachments`: multipart `files`, at most five files, 20 MiB each. Returns `{attachments}`. IDs are bound atomically when sending/editing.
- `GET /attachments/:uuid`: ACL-checked streaming/range download. `?download=1` requests a download disposition.
- `GET /events?after=id`: persisted ordered events `{events,nextCursor,hasMore}` (200 per page).

Ticket DTO: numeric `id`/`number`, `ownerId`, `title`, `status`, timestamps, source-ticket reference, `itRequested`, `members`, unread count, last message, `canReopen`, `aiEnabled:false`. Member mini-user: `{id,name,avatarUrl}`. Message DTO: ID/sequence, author, role, kind, text, timestamps, reply preview, forwarding reference, optional rating, attachments and reactions. Attachment URLs are relative `/help/attachments/:uuid` and require the same Bearer authorization; no S3 keys or public signed URLs are exposed.

## Events and notifications

Socket client emits `help:subscribe {}` for all accessible events, or `{ticketId}` to additionally validate a selected ticket. `help:unsubscribe` removes that socket's Help subscription. Shared clients should keep one app-level subscription. `help:typing {ticketId,typing}` is throttled and delivered with `userId,name,expiresAt`; it is ephemeral, unlike messages.

`help:event` contains `{id,ticketId,type,actorId,messageId,createdAt}`. Consumers deduplicate IDs and refetch affected snapshots. Events are stored in the same transaction as mutations, with commit-order locking to prevent reconnect cursors skipping a slower transaction. A polling fallback repairs missed live emissions.

`HelpNotification` is a transactional push outbox. The worker checks current ACL/settings/read state, excludes the sender, leases rows, retries with backoff up to ten attempts, and uses existing device-token/Expo delivery. New ticket/IT request also notifies eligible IT roles. Push payload: `{type:'HELP_MESSAGE',ticketId,messageId,eventId}`, Android channel `help-message`. Message bodies are not placed in push notifications. Delivery to an actual device still requires valid platform push credentials and registered device tokens; automated tests cannot prove physical delivery.

## Storage and limitations

Help uses the existing **private** `S3_BUCKET` by default and stores objects under `${S3_ENV_PREFIX}/help/<uuid>` (`dev/help/` on development). An explicit `HELP_S3_BUCKET` selects a dedicated bucket instead. Optional `HELP_S3_ENDPOINT`, `HELP_S3_REGION`, `HELP_S3_ACCESS_KEY`, `HELP_S3_SECRET_KEY` configure an independent Help-only client; unspecified endpoint/region and a fully absent dedicated credential pair fall back to existing S3 settings. If either dedicated key is set, both must be set: shared/dedicated keys are never mixed. Shared storage configuration is not changed.

The selected bucket must pass both policy and ACL privacy checks before uploads/downloads. Existing private storage needs no bucket-creation permission. Provision a dedicated **private** bucket through the provider's administrative interface only if existing storage is public or separate storage is desired. Put overrides only in protected environment settings, never in chat, Git or logs. Required permissions are bucket head/list metadata, `GetBucketPolicy`, `GetBucketAcl`, `PutObject`, `GetObject`; `CreateBucket` is only needed for automatic initial provisioning. Unknown/denied privacy inspection fails closed. No public-storage fallback exists and no bucket policy is modified.

The general `/files/*` proxy rejects `<environment>/help/*` before token/cache/S3 processing, including valid general file tokens. Attachments are served only through `/help/attachments/:id` with ticket membership checks. When sharing a bucket across environments, all other deployed file proxies must require secure, key-scoped tokens or block Help prefixes too; dev cannot safely share a bucket with an anonymously accessible legacy proxy. Live verification on 2026-10-23 confirmed the existing production proxy rejects anonymous requests (401); production was not modified.

The bucket is created without a public policy when permitted; wildcard Allow policies and ACL grants to `AllUsers`/`AuthenticatedUsers` are rejected. Privacy is checked on upload and authenticated download, cached for at most60seconds. Missing, denied, or unavailable storage returns HTTP503 `HELP_STORAGE_UNAVAILABLE` with a safe Russian message; proven public storage returns `HELP_STORAGE_NOT_PRIVATE`. Diagnostic logs include only provider error name/code/status, never credentials or request details. An explicit `NoSuchBucketPolicy` is accepted only with a private ACL; arbitrary404 is not proof of privacy.

Downloads proxy through authenticated Help routes; generic `/files` cannot address Help objects in this bucket. Server MIME detection uses signatures, never the filename. Active HTML/SVG and arbitrary binary formats are rejected; documents/archives are download-only and never executed or parsed. Audio/image data is delivered inline with `nosniff`, private cache and restrictive CSP. The dev smoke's anonymous-object probe uses the same Help client settings as uploads.

This first no-AI release does **not** implement antivirus scanning, document extraction, transcription or server-side audio-duration decoding. Limits are file size/count; verify real Android/iOS audio encoding and push delivery on a device. Do not describe files as malware-scanned. Upload buffering is limited to two requests globally and one per user per process. Unbound/cancelled uploads are kept; there is no automatic history/file deletion.

## Safe development schema application

`scripts/apply-help-migration.js` applies only `20261023070000_help_service/migration.sql`. It requires `HELP_MIGRATION_TARGET=dev`, `HELP_MIGRATION_DATABASE_CONFIRM` equal to the development database name and explicit `DB_ACCEPT_DATA_LOSS=0`. Use an approved backup first. It takes a transaction/advisory lock, refuses partial schemas, validates columns/indexes/constraints/registration, and records a normalized SQL checksum in `HelpSchemaVersion`. It does not reset databases, run unrelated migrations, drop data or grant IT roles. Re-running verifies the existing schema/checksum. It has not itself been authorized for production.

Verification commands: `npm run type-check`; `npm run test:unit -- --runInBand help.policy.unit.test.ts`; the dedicated `node scripts/run-help-integration.cjs` creates a uniquely named local test database and leaves it intact, without shared test database reset or `down -v`.
