# Order integrity hotfix (production base b6587ad)

## Dev customer purchase history — 2026-10-10 (deployed to dev)

- Code commit `3c302e27bb11adf34000086200b043770630e9ea`; workflow `38044110811` succeeded, production job skipped. Running dev image matches CI: `sha256:5717852ec2eb06984e867da1a2629945f374c11a81e14cee11c3a29d970cf166`.
- Added authenticated `GET /api/client-orders/purchase-history` and `purchasedOnly` product filter. Exact customer/organization context, history protocol validation, five-minute user-scoped cache; filtering occurs in 1C before pagination, without fuzzy results escaping the filter.
- Cloud dev reaches **WMS15** with `clientOrdersApiVersion=2026-10-09-customer-purchases-v55`, `purchaseHistoryApiVersion=customer-purchases-v1`. The previously authorized WMS15 update was already installed; no 1C update in this release.
- No Prisma/schema change. Fresh dev backup streamed off-server: `C:\Share\Backups\leader-api-dev\20261010-purchase-history\LeaderAPI_dev.dump`, 202314808 bytes, SHA-256 `dbfd3a303319fa7df5a2af329638762733aa1e7292fbae866a1879e0e24542ba`; `pg_restore --list` validated (1017 entries). Private backup, never commit it.
- Prior running image retained as `ghcr.io/extectick/leaderproductapi:rollback-dev-purchase-history-20261010`, image ID `1e7716137978a741a054cb702c42e8857dc14a3944bc57b9c355f6c88c7441f1`. `DB_ACCEPT_DATA_LOSS=0`; rollback the application without destructive schema changes.
- Typecheck and 75 targeted API tests passed, followed by the complete CI order-integrity gate. Public dev HTTP checks: anonymous 401; missing history/filter context 400; 26 purchased products over two pages without duplicates/non-purchased rows; search plus stock plus purchase filter returns 3 matching products; a real second organization returns empty history and empty filtered products; old unfiltered products still load; cached history is reused. No business order created or submitted.
- Dev database schema and server-local Compose overrides unchanged. Production container image/start time, schema and release metadata unchanged. About 2.4 GiB free after deploy; no image/data/cache cleanup performed.
- APP OTA release is documented separately in `LeaderProductAPP/docs/offline-order-workflow-20260924.md`; physical-device UI acceptance remains separate from API checks.

## Dev draft recovery — 2026-10-09 (deployed to dev)

- Additive migration `20261009120000_client_order_draft_backups`: `Order.draftReview` and owner-scoped `ClientOrderDraftBackup`.
- `PUT/GET /api/client-orders/draft-backups/:clientOrderId`: recovery JSON accepts incomplete forms, never calls 1C/export, revision/hash protected. Only the authenticated owner can read it; client-supplied user IDs are ignored. Incomplete backups are not ordinary list orders.
- Offline SUBMIT commits its backup before live validation. A stock rejection also persists a normal `DRAFT` with lines/review, returns 422 with `draftSaved/serverGuid`, and never queues it. Direct legacy submit cannot bypass the outstanding stock review.
- Retrying a rejected, never-submitted draft applies current prices when explicitly chosen; correcting its quantities does not change accepted 1C facts. Queued/exported orders retain the existing integrity guards.
- APP receives structured shortages and keeps them in SQLite. Backup sync is not permission to submit; network recovery only backs up or reconciles an already attempted operation.
- Deployment order: dev database/API first, compatible APP OTA next. No 1C change or new native dependency. Do not apply these changes to production as part of this task.
- Real PostgreSQL test (mocked 1C/export): use the isolated local test database on `127.0.0.1:54329`, schema `draft_recovery_20261009`; `prisma db push`, then `npm run test:unit -- --runInBand --testMatch '**/clientOrderDraftRecovery.integration.test.ts'`. Test guards reject other databases/schemas.
- Verified: 49 API unit/route tests, 6 isolated PostgreSQL scenarios (incomplete backup, shortage, successful retry, current prices, 1C outage, concurrent revisions), Prisma validation and TypeScript. No real 1C order was created; mobile physical-device QA remains separate.

### Approved dev release, 2026-10-09

- API commit `e923710adb25e7a2c9227d64b1f86e570056019b`; workflow `37933022747` passed tests, built and deployed **development only**. Production job skipped.
- Running dev image digest: `sha256:1e7716137978a741a054cb702c42e8857dc14a3944bc57b9c355f6c88c7441f1`, matches the CI-published image.
- Dev DB backup streamed off-server to `C:\Share\Backups\leader-api-dev\20261009-draft-recovery\LeaderAPI_dev.dump`: 202311112 bytes, SHA-256 `48ef61a5688b1d7a65754596de3978e924a84847e44ea7ddccc6dffd0652aba5`; `pg_restore --list` validated (1012 entries). Contains private data; do not commit/upload publicly.
- Previous running dev image retained as `ghcr.io/extectick/leaderproductapi:rollback-dev-draft-recovery-20261009` (image ID `64a4948457d1bc826f9065f5ba5f794e5b4234457dfd159e2c0008d0af0c3dee`). Preserve the additive schema on application rollback; do not run old `db push` with data loss allowed.
- `DB_ACCEPT_DATA_LOSS=0`; schema applied by the existing safe `db push` startup. Post-deploy `prisma migrate diff --from-config-datasource --to-schema ./prisma --exit-code`: no difference.
- Public dev `/health`: 200, development, DB/Redis/S3 healthy. Seven real HTTP smoke assertions passed: incomplete backup/readback, owner isolation 404, anonymous 401, old revision 409, conflicting revision 409, no business order created. Only the synthetic backup was removed afterward.
- Existing order status counts unchanged. Production container image/start time unchanged; production `/health` remained healthy. 1C was not updated and no order was sent to it by these checks.
- User-approved cleanup removed only three verified unreferenced API images (`d76204a`, `abe8e93`, untagged `e99153a`). Running/rollback images, containers, volumes, data and build cache preserved. Disk remains low (~1.2 GiB after the new image); plan capacity expansion separately.

Incident: НОУТ-112398, 2026-09-17, appGuid eb9e7c06-4a52-43aa-b764-1aee8a0f78ac.
First export had 7 lines, next client revision had 5. Missing: mustard sauce (2 × 360), pineapple (4 × 180).

## Release boundary

- No production writes/deployment during implementation.
- Production hotfix is based on main, not the offline/tracking dev branch.
- APP hotfix is based on main 4328bbc. Forward-port both fixes to dev.
- No new DB schema in this hotfix; immutable snapshots/packets use OrderEvent.
- Do not deploy dev migrations to production. Current prod has no Prisma migration baseline and defaults to db push.
- Do not roll back by running an older schema with accept-data-loss. Save image digest and backup before deployment.

## Acceptance checklist

- [x] Reject implicit removed/replaced/cancelled/reduced lines on both app mutation endpoints.
- [x] Bind review confirmation to actor, current content/revision and proposed payload, expiring in 10 minutes; content conflicts require manual resolution.
- [x] Audit accepted contents before/after changes, including autosaves (rejected requests do not commit a DB event).
- [x] Freeze export packets in OrderEvent and correlate ACK to exact revision; serialize per-order sending with PostgreSQL session/xact advisory locks.
- [x] Prevent live list/status/pull ACK from completing a newer direct-push revision.
- [x] Do not return old 1C items labelled with a newer API revision.
- [x] APP confirmation, no blind conflict retry, no stale queue completion overwriting edits.
- [x] Production-base regression suites and typechecks; real PostgreSQL lock test on isolated localhost:54329.
- [x] Forward-port and run checks on dev; keep offline/tracking changes.
- [ ] WMS15 end-to-end QA with loss of HTTP response, manual 1C edits and delayed responses.
- [x] Approved production deployment and OTA (2026-09-18).

## Compatibility / operational details

- Existing APKs cannot confirm reductions: they receive a 409 explaining that an update or editing in 1C is required. Creation and unchanged retries retain the old API contract.
- The new APP sends content tokens. SAVE does not inherit an old SUBMIT for token-aware requests.
- Direct worker owns MANAGER_APP export by default; `/orders/queued` only serves marketplace orders. Legacy uncorrelated ACKs for direct-owned orders are acknowledged as deferred, not applied.
- A deployment explicitly disabling the direct worker retains legacy pull transport and requires separate QA; do not silently switch this flag on rollback.
- ACCESS_TOKEN_SECRET must be configured to sign review challenges. Missing secret fails closed.
- Unknown-result direct packets block editing between retries. Stock/response mismatch validation stops automatic sending for manual review.
- Retry an already frozen packet without a new stock preflight: the first request may already have reserved its stock in 1C.
- Normalize the base-unit package=null representation returned by 1C; compare line identity, product, quantity and base quantity.
- Financial validation/1C posting rules are unchanged. No changes to 1C sources in this hotfix.
- Before release, record current image digest, back up DB, inspect pending operations, and test the APK/OTA runtime. No DB migration is required for this stage.

## Follow-up (not silently included in the hotfix)

Dedicated version/outbox tables and append-only operation ledger need a separately tested additive migration/baseline.
Strict atomic compare-and-set against simultaneous manual edits inside 1C requires a 1C protocol change.
Long-lived timeout/unknown-result reconciliation and old pull-only deployments need integration QA against WMS15.

## Verification / delivery, 2026-09-18

- Production-base API: TypeScript and 63 tests across 6 targeted suites passed.
- Dev API: TypeScript and 81 targeted tests across 8 suites (includes geo and offline policy).
- Real PostgreSQL test: localhost:54329 only; export/writer mutual exclusion and rollback verified without Redis.
- APP: production-base 77 tests; dev 98 tests; both TypeScript checks passed.
- Branches: hotfix/order-integrity-prod (production base), integration/order-integrity-dev (forward-port).
- No push, production deployment, OTA or 1C update performed. The incident order was not resent or modified.
- Release next: WMS15/device end-to-end QA, approved API deployment, then compatible APP OTA. Old APKs cannot confirm destructive changes.

## Production release, 2026-09-18 (subsequent user approval)

- API main/origin: fb45be08bffe218829fa6851bfe3fb9f0ddcb9f7.
- API workflow: https://github.com/Extectick/LeaderProductAPI/actions/runs/35329633786 — success.
- APP main/origin: 2b865b4e7cb6b33217f4caed95cf2eebb1a0a0ec.
- OTA workflow: https://github.com/Extectick/LeaderProductAPP/actions/runs/35330170252 — success.
- Web APP workflow: https://github.com/Extectick/LeaderProductAPP/actions/runs/35330170313 — success.
- APK workflow 35330170309 succeeded with APK build skipped: no native changes.
- Production OTA: 0.1.26.4, runtime 0.1.26, updateId 810d73e8-fe05-48ca-9c3e-b602862e521e.
- Verified public manifest, downloaded bundle (19,985,525 bytes), matching SHA-256; current update returns 204.
- API health: production, DB/Redis/S3 OK; API container healthy; web HTTP 200.
- Read-only in-process production smoke: reducing the incident order's 5 lines to 3 produces a review challenge; exact signed confirmation accepted. No order writes/resends during verification. This is not a device/WMS15 end-to-end test.
- Pre-release schema diff: no difference. Queue: no QUEUED/CANCEL_REQUESTED orders; 2 pre-existing ERROR orders remained unchanged.
- Backup: /opt/leader-api/restores/order-integrity-release-20260918-oattFs/LeaderAPI.dump (14 MB, pg_restore list validated).
- Backup SHA-256: ebd2b9a9c3b1c25ddde6cde6022293087594baec7fc26dc22ef7729eb19034a0.
- Previous API image: sha256:d16cef52d0a8bed79163b33bace6f0835dbf93db089cc0acebdf7e5d86ef5bb4.
- Current API image: sha256:7356ada957366ae75e68942eac7332d9c98b288da61b37a39bcb98fba847f30c.
- Rollback image tags retained on server: leaderproductapi:rollback-order-integrity-20260918 and leaderproductapp:rollback-order-integrity-20260918 (ghcr.io/extectick namespace).
- No 1C source/configuration update and no dev deployment in this release. Forward-port remains in local dev.
