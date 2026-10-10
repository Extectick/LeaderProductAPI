# Full dev promotion to production — 2026-10-11

User explicitly requested production APP/API update and separate commits. No production 1C changes.

- [x] Merge dev 532b445 onto production 11a4bf0, retaining all production-only journal retention and OTA safety fixes.
- [x] Validate types and 63 unit tests: order integrity, backups, sharing and authorization. Production retention implementation is byte-for-byte unchanged from main.
- [x] Stream and validate fresh production DB backup off-server; preserve rollback image/config.
- [ ] Apply only additive schema changes with DB_ACCEPT_DATA_LOSS=0; deploy immutable image.
- [ ] Enable production sharing and same-origin public web; leave dev untouched.
- [ ] Verify health/schema, production 1C read-only connectivity and release artifacts.

Rollback keeps the added columns/tables and restores the previous image/config. Never run a destructive old-schema db push.

Backup: `C:\Share\Backups\leader-api-prod\20261011-latest-dev\LeaderAPI.dump`, 115613421 bytes; SHA-256 `05e974c7adc5e7b421011ce84a958cbbcaa06be72dbaf3d95a2113508d94f58e`. Full archive decompressed via `pg_restore --file=/dev/null`, without restoring production. Directory restricted to Administrators/SYSTEM. Previous image `5be4648c` retained as `rollback-prod-latest-20261011`; protected env/Compose copies under `/var/backups/leader-release-20261011`.
