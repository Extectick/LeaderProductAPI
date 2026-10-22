# Public order sharing (dev)

## Scope and progress

- [x] Agreed UI: 4 desktop / 2 mobile photo cards; total beside delivery at bottom; manager phones, MAX and Telegram.
- [x] Inspect clean dev branches and existing order persistence, images, profile/admin and release pipelines.
- [x] Add dedicated client-facing contact settings, own-profile and admin editing.
- [x] Add revocable, expiring order links and strictly allowlisted read model.
- [x] Add conditional polling (ETag, 5 seconds while visible), reconnect reconciliation and last-good display on network errors. No public access to employee sockets.
- [x] Add lightweight responsive public web entry, not the employee application shell.
- [x] Add share/manage actions to mobile and web order editors, explicitly SAVE (never SUBMIT).
- [x] Unit/type/build checks, API integration checks and desktop/mobile browser QA.
- [x] Back up dev database, deploy only dev API/web/OTA and verify published artifacts.

## Contract

The shared view shows saved document prices, quantities, photos and totals, not current catalog prices or warehouse availability. Local-only drafts must first be explicitly saved to API; sharing must not enqueue an order or submit to 1C. The link is stable until revoked/rotated/expired. Default lifetime: 30 days, renewed explicitly by manager.

New/rotated link codes use 12 URL-safe characters from 9 cryptographically random bytes. Existing 43-character links remain valid and stable; explicit rotation replaces them with a short code and invalidates the previous link. Both lengths use the same hashed lookup, encrypted storage, expiry/revocation and nginx rate limits.

Only declared public fields leave the server. Internal order DTO, notes, cost/profit, stock, geolocation, bot identifiers and credentials must never be included. A URL fragment carries the capability token; API uses Authorization headers and does not log sharing bodies. Public channels cannot join employee sockets/rooms.

Client contact settings are separate from login, verified phone and Telegram/MAX account linking. Empty custom phone list falls back to the standard phone. Up to five labelled custom numbers; optional explicit Telegram/MAX profile links. Self-edit and manage_users admin edit use the same validated contract. Changing customer invalidates previous access.

Use current saved API order rows for manager documents. A cached public snapshot covers live-only 1C documents; refresh it in a bounded, single-flight background path for active links. Never call 1C for every public page view, and keep a last good snapshot on transient failure. No 1C writes or extension changes.

## Public weights

Public items include nullable `weightKg` for the **whole line**, not one piece.
The aggregate includes nullable `totalWeightKg`, `weightComplete` and
`missingWeightItems`. A missing catalog mass is unknown, never a fabricated zero;
a partial sum must not be presented as a complete order weight.

Explicit mass units and original package coefficients are respected. Do not parse
mass from product names. Arithmetic uses Decimal and excludes cancelled lines.
Current saved quantities always recompute the line mass. Unit/reference changes
cannot reuse a different package's cached mass.

Local catalogs do not persist physical mass. A bounded, reference-only 1C read
therefore fills a private per-unit cache in the existing share snapshot JSON,
without a schema migration or business-order writes. Public GETs do not await
1C: at most three refreshes run concurrently, a link has a one-minute retry budget,
large orders use batches of 50 and successful reference cycles are checked every
six hours. Transient failures retain the last known reference masses. Concurrent
rotation/revocation/refresh is protected with a version/token/owner/customer CAS.
The private cache and all other catalog prices/identifiers stay out of public JSON.

## Messenger-safe path links

`ORDER_SHARE_PATH_LINKS_ENABLED=1` changes newly copied addresses to `/order/<code>` without rotating the existing capability or changing expiry. Existing `/order/#<code>` links remain supported by the public page. Generic messenger preview cards can omit fragments; path codes stay in the destination sent to the server. This does not suppress the messenger's own external-site warning.

Deploy in order: public web with both formats; nginx path entry with inherited no-referrer/no-index/CSP headers and disabled request/error logging for capability paths; API; then enable the flag only in the target environment. Public JSON/images still use bearer headers and the same authorization, revocation, expiry and rate limits. Never put customer data or order totals in preview metadata. Validate HTML/assets, old and new entry points and absence of code in access logs. Rollback: disable the flag; keep path-reading support for links already sent.

## Rollout boundary

APP and API have separate commits. Production, production 1C and unrelated dirty primary worktrees remain untouched. Public web has a separate static dev deployment under /order/ on dev.leader-product.ru. No new native modules are required.

## Verification and deployment, 2026-10-10

- Dev DB backup: `/opt/leader-api-dev/backups/before-public-order-20261010.dump` (193 MB, `pg_restore --list` checked), protected configuration backup alongside it.
- API commit `53263d9`; GitHub run `38052075239` passed tests, build and development deployment. Production job skipped. Sharing enabled only in dev.
- API unit tests: 9 passed. APP workspace regression tests: 65 passed, including explicit server SAVE and preventing a queued document from being downgraded for sharing.
- `scripts/test-public-order-dev.cjs` executed in the dev container. Passed contact editing permissions/validation, stable concurrent publication, strict public projection, image scoping, ETag/quantity update, token rotation/revocation/expiry and credential separation. Demo order remains DRAFT with no 1C queue entry.
- Dev OTA run `38052271825`: runtime `0.1.34`, update `0.1.34.3`, update ID `ff071ada-5195-478a-863e-f011bf4e044e`. No APK needed.
- Public web uses a separate static workflow and an atomic release symlink. Nginx configuration validated before reload; rate limits and no-index/no-referrer policy enabled.
- Demo fixtures use `@example.invalid` users without passwords and order GUID `qa-public-order-demo`. Prices/contact numbers are fictitious; product photos come from the dev catalog. Do not send this order to 1C.
- The detailed responsive visual QA report lives in the APP worktree at `design-qa.md`. Android device interaction with the new profile/share controls has not been manually tested in this run.
