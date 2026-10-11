# Unsent draft reduction — 2026-10-11

## Incident and explicitly authorized recovery

Production manager draft `1a62a842-94f5-43f1-bd0d-0633416c5981` had not reached 1C. Its saved API revision contained 60 kg of beef; the latest device/recovery revision 6 contained 20 kg and four lines totaling RUB 162064. The generic reduction guard treated this ordinary draft edit like an already accepted order change.

After user authorization, verified no matching order in 1C, then submitted exactly recovery revision 6 using the existing client identity and signed confirmation mechanism through the normal API (no direct order-table repair or 1C write bypass). The export worker created and posted `НОУТ-122474`, 1C GUID `a6aba773-c541-11f1-9d3a-f1cbadb7fc65`; all four quantities/prices and total matched a fresh 1C detail read. API acknowledged `SYNCED`, no export/1C error, at `2026-10-11T07:02:03.984Z`.

## Fix and checks

- Only explicitly identified MANAGER_APP / DRAFT / DRAFT records with no queue, submission, attempt, 1C number/date/snapshot, posting or realization evidence can edit quantities/lines without reduction confirmation. Missing state fields fail closed.
- Content-token conflict validation still runs before the exemption. Queued, ambiguous and exported orders retain the existing confirmation, lock and audit protection. No schema or 1C changes.
- 50 focused unit tests and TypeScript check passed. Seven integration tests passed against a newly created local `draft_recovery_20261011_unsent_1` schema on test PostgreSQL port 54329, with mocked 1C/export transport. The regression covers SAVE 60 -> SUBMIT 20, two added lines, stale-token rejection, idempotent retry, and reduction protection after queueing. No test fixtures were sent to production.
- Fresh production backup `/var/backups/leader-unsent-draft-20261011/LeaderAPI.dump`, mode 600; full decompression validated by pg_restore. Off-server copy `C:\Share\Backups\leader-api-prod\20261011-unsent-draft\LeaderAPI.dump`, restricted ACL. Bytes 140515427, SHA-256 `b1126a873f9f20da2d9a4db120989de285500604cc4e6826a8684692cd7f66af`.
- Previous image retained as `rollback-unsent-draft-20261011`; protected env/Compose copies alongside the server backup. No cleanup, volume deletion or 1C extension update.

Deployment and post-release verification are recorded after CI completes. User explicitly authorized production API and OTA release.
