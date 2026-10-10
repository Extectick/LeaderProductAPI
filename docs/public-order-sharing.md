# Public order sharing (dev)

## Scope and progress

- [x] Agreed UI: 4 desktop / 2 mobile photo cards; total beside delivery at bottom; manager phones, MAX and Telegram.
- [x] Inspect clean dev branches and existing order persistence, images, profile/admin and release pipelines.
- [ ] Add dedicated client-facing contact settings, own-profile and admin editing.
- [ ] Add revocable, expiring order links and strictly allowlisted read model.
- [ ] Add scoped realtime notifications and reconnect/fallback reconciliation.
- [ ] Add lightweight responsive public web entry, not the employee application shell.
- [ ] Add share/manage actions to mobile and web order editors, explicitly SAVE (never SUBMIT).
- [ ] Unit/type/build checks, API integration checks and desktop/mobile browser QA.
- [ ] Back up dev database, deploy only dev API/web/OTA and verify published artifacts.

## Contract

The shared view shows saved document prices, quantities, photos and totals, not current catalog prices or warehouse availability. Local-only drafts must first be explicitly saved to API; sharing must not enqueue an order or submit to 1C. The link is stable until revoked/rotated/expired. Default lifetime: 30 days, renewed explicitly by manager.

Only declared public fields leave the server. Internal order DTO, notes, cost/profit, stock, geolocation, bot identifiers and credentials must never be included. A URL fragment carries the capability token; API uses Authorization headers and does not log sharing bodies. Public channels cannot join employee sockets/rooms.

Client contact settings are separate from login, verified phone and Telegram/MAX account linking. Empty custom phone list falls back to the standard phone. Up to five labelled custom numbers; optional explicit Telegram/MAX profile links. Self-edit and manage_users admin edit use the same validated contract. Changing customer invalidates previous access.

Use current saved API order rows for manager documents. A cached public snapshot covers live-only 1C documents; refresh it in a bounded, single-flight background path for active links. Never call 1C for every public page view, and keep a last good snapshot on transient failure. No 1C writes or extension changes.

## Rollout boundary

APP and API have separate commits. Production, production 1C and unrelated dirty primary worktrees remain untouched. Public web has a separate static dev deployment under /order/ on dev.leader-product.ru. No new native modules are required.
