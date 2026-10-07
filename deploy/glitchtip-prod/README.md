# Production APP diagnostics

Production ingestion enabled on 2026-10-08, independently of the business API.
No API container rebuild, business migrations or 1C updates are necessary.

- GlitchTip: existing local `leader-glitchtip-dev` deployment, separate production
  organization `leaderproduct-production` and project `leaderproduct-app-production`
  (id 3). Dev project/data and its signed-summary bridge are unchanged.
- Public ingestion only: `https://api.leader-product.ru/sentry/api/3/envelope/`.
  Store/minidump endpoints for this project are also routed, but native crash
  reporting is not enabled by the runtime-0.1.26 OTA.
- Admin API/UI remain private at `http://127.0.0.1:19000`; cloud loopback 19001
  reaches this service through the existing protected SSH tunnel.
- Production credentials: `C:\ProgramData\LeaderProduct\GlitchTipProd\credentials.json`,
  accessible only to SYSTEM/Administrators. Never print or commit this file.
- Matching source maps are private. APP workflow forwards cloud loopback using
  pinned known-host keys and uploads maps before publishing an OTA.
- Business production API has no AppCrashEvent table. Read actual reports in
  GlitchTip; do not claim API-summary persistence is enabled.

## Provisioning / verification

`bootstrap.py` runs in the existing diagnostic image's `manage.py shell`, with
the dev credentials mounted read-only at `/run/leader-dev-credentials.json`
and the protected prod directory at `/run/leader-prod`. It is idempotent and
uses auto-generated slugs as lookup keys; never create a project on each run.

`install-ingress.py` installs only the scoped nginx snippet and rate limit,
backs up the existing site/snippets and restores them if validation/reload fails.
Deployed backup: `/var/backups/leader-crash-prod/20261007T201018Z`.
The public endpoint is POST-only, bounded/rate-limited, does not log request
URLs, and does not forward client IP headers to GlitchTip.

`node deploy/glitchtip-prod/verify.cjs` sends an explicitly synthetic event.
`node deploy/glitchtip-prod/verify.cjs read <eventId>` verifies persistence.
Initial stored event: `903f6a8fe183f84f89236484c9ab1544`; public admin API 404,
anonymous private API read 401. This tests transport, not a crash on a phone.

## Availability and limitations

GlitchTip still runs on this Windows workstation. Docker Desktop was stopped
and was started during setup. Collection needs the workstation, Docker and
the SSH tunnel available; native transport buffers sanitized JS reports locally
when unavailable, subject to the SDK queue limits. This is not an always-on VPS
installation. A permanent server migration is a separate infrastructure task.

Runtime 0.1.26 gets JS/fatal-JS/unhandled-rejection and router-error collection
after applying the OTA. Java/NDK/ANR and pre-JS failures remain disabled until
an APK with the early native privacy hook is explicitly released. An OTA cannot
install that hook. No phone/native-crash acceptance test is claimed.
