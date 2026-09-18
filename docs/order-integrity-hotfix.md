# Order integrity hotfix (production base b6587ad)

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
