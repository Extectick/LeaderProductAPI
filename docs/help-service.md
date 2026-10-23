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

Help uses a separate S3 bucket, `HELP_S3_BUCKET` or `${S3_BUCKET}-help-private`, and the existing environment prefix. The bucket is created without a public policy when needed; wildcard Allow policies are rejected. Downloads proxy through authenticated Help routes; generic `/files` cannot address this bucket. Server MIME detection uses signatures, never the filename. Active HTML/SVG and arbitrary binary formats are rejected; documents/archives are download-only and never executed or parsed. Audio/image data is delivered inline with `nosniff`, private cache and restrictive CSP.

This first no-AI release does **not** implement antivirus scanning, document extraction, transcription or server-side audio-duration decoding. Limits are file size/count; verify real Android/iOS audio encoding and push delivery on a device. Do not describe files as malware-scanned. Upload buffering is limited to two requests globally and one per user per process. Unbound/cancelled uploads are kept; there is no automatic history/file deletion.

## Safe development schema application

`scripts/apply-help-migration.js` applies only `20261023070000_help_service/migration.sql`. It requires `HELP_MIGRATION_TARGET=dev`, `HELP_MIGRATION_DATABASE_CONFIRM` equal to the development database name and explicit `DB_ACCEPT_DATA_LOSS=0`. Use an approved backup first. It takes a transaction/advisory lock, refuses partial schemas, validates columns/indexes/constraints/registration, and records a normalized SQL checksum in `HelpSchemaVersion`. It does not reset databases, run unrelated migrations, drop data or grant IT roles. Re-running verifies the existing schema/checksum. It has not itself been authorized for production.

Verification commands: `npm run type-check`; `npm run test:unit -- --runInBand help.policy.unit.test.ts`; the dedicated `node scripts/run-help-integration.cjs` creates a uniquely named local test database and leaves it intact, without shared test database reset or `down -v`.
