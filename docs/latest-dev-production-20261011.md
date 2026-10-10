# Full dev promotion to production — 2026-10-11

User explicitly requested production APP/API update and separate commits. No production 1C changes.

- [x] Merge dev 532b445 onto production 11a4bf0, retaining all production-only journal retention and OTA safety fixes.
- [x] Validate types and 63 unit tests: order integrity, backups, sharing and authorization. Production retention implementation is byte-for-byte unchanged from main.
- [x] Stream and validate fresh production DB backup off-server; preserve rollback image/config.
- [x] Apply only additive schema changes with DB_ACCEPT_DATA_LOSS=0; deploy immutable image.
- [x] Enable production sharing and same-origin public web; leave dev untouched.
- [x] Verify health/schema and production 1C read-only connectivity; APP artifact verification is recorded separately.

Rollback keeps the added columns/tables and restores the previous image/config. Start the old API with `node dist/index.js`, bypassing its old-schema initialization script; never run a destructive old-schema db push.

Backup: `C:\Share\Backups\leader-api-prod\20261011-latest-dev\LeaderAPI.dump`, 115613421 bytes; SHA-256 `05e974c7adc5e7b421011ce84a958cbbcaa06be72dbaf3d95a2113508d94f58e`. Full archive decompressed via `pg_restore --file=/dev/null`, without restoring production. Directory restricted to Administrators/SYSTEM. Previous image `5be4648c` retained as `rollback-prod-latest-20261011`; protected env/Compose copies under `/var/backups/leader-release-20261011`.

## Verified release

- Code `26af3b4bea545a66d1681f046d5166e36aab7358`; workflow `38090467422` succeeded. Production image `sha256:ea89265ffd2029d1e6db66acc7d385ada20eb19c55b35a727481f677cbba1779`, immutable source tag pinned in `.env`. All unrelated configuration compared equal to the backup, including 1C and database settings. Server-local Compose overrides preserved.
- Additive schema is current: `prisma migrate diff --from-config-datasource --to-schema ./prisma --exit-code` reports no difference. No accept-data-loss or migration reset. New backup/share tables and nullable columns available.
- HTTPS read-only smoke: health 200; authenticated own contacts 200; absent owned share 200/null; absent draft backup 404; public route without capability 410; anonymous contacts/share management 401. No business order created or submitted by release verification.
- Production 1C ping: HTTP 200, `/torg2026/hs/lp-app/ping`, `2026-10-09-customer-purchases-v55`, `customer-purchases-v1`. No 1C modification/session termination.
- 11 real PostgreSQL retention tests passed against a newly created, explicitly guarded local `LeaderAPI_retention_release_20261011`; no fixtures executed against prod/dev databases. Initial 63 targeted unit tests/typecheck and full CI order-integrity gate passed.
- Sharing enabled with independent random encryption secret (not logged), public origin `https://api.leader-product.ru`; protected nginx/env backup `/var/backups/leader-public-order-prod-20261010T220927Z`. Nginx test passed before reload. APP public web workflow `38090494167` succeeded; served JS/CSS match the local build, HTML matches ignoring Windows line endings. No-index/no-referrer policies present.
- Dev container image `e258c44a` was not changed. Its start time remained `2026-10-10T19:53:45.210558631Z` through deployment; a subsequent external host reboot restarted both containers at approximately 22:22 UTC.
- User explicitly authorized cleanup: removed seven unused old API images and two unused CLI helper images (`minio/mc`, `amazon/aws-cli`), rechecking all running/stopped container references and rollback tags immediately before removal. No force/prune, volumes, caches, DB or backup deletion. API image metadata retained under the protected release backup directory. About 1.1 GiB was free after web deployment; an external disk expansion subsequently increased free space to approximately 41 GiB of 77 GiB.
- External host reboot at `2026-10-10T22:22:01Z` left nginx stopped: its private diagnostics listener tried binding `172.20.0.1:16186` before that Docker bridge address existed. After the network became available, `nginx -t` passed and `systemctl start nginx` restored production/dev HTTPS, order web and APK download HTTP 200. No reboot, disk resize or nginx configuration change was performed by this release. A boot-time retry improvement was offered separately and requires approval.
- Production synthetic Java event `4377a97425347aac44fa23a200138dc0` and native fixture `166e9fe48db9488f8663c6040b4dccb7` ingested/read back with production environment. These test transport/parsing, not a physical-phone crash. The production diagnostic backend remains on the existing private workstation/tunnel; no unrequested infrastructure migration was performed.
