# Dev crash reporting (Sentry self-hosted)

## Current dev deployment: 2026-10-09

Supersedes the initial infrastructure notes below: dev now uses lightweight
GlitchTip 6.2.6 (not the full Sentry stack), privately on the cloud API host.
Production ingestion and the old local diagnostic database are unchanged.

- Compose directory `/opt/leader-diagnostics-dev`, project `leader-glitchtip-dev-cloud`.
- Reviewed deployment files: `deploy/glitchtip-dev-cloud`; private secrets are
  provisioned separately, excluded from Git, never passed in command arguments.
- Web only on `127.0.0.1:19002`; admin/read/symbol upload through SSH forwarding.
- Public dev nginx accepts only SDK ingestion for the dedicated dev project;
  rate/body limits, no access logs, all other `/sentry/` paths return 404.
- Dedicated PostgreSQL volume, capped memory/CPU, bounded logs. Events: 14 days;
  diagnostic files: 60 days. Private object storage prefix `dev/diagnostics/storage`.
- `initialize-private.ps1` refuses to overwrite existing secrets. Provision files,
  build/start PostgreSQL and web, run bootstrap once, then start the bridge profile.
  `configure-storage.py` reads dev API S3 credentials internally. Run
  `verify-storage.py` through `manage.py shell`, then `install-ingress.py` and
  `smoke.py`. Ingress script preserves a dated rollback copy and validates nginx.
- Ingress backup: `/var/backups/leader-crash-dev-cloud/20261009T090116Z`.
- Synthetic event `d2640535e8f64934b9db63510da92ce3` stored through public HTTPS.
  S3 write/read, signed URL and denied anonymous object access verified.
- GitHub APP **development** secrets point to this private project. Production
  secrets remain unchanged. CI uses private port 19002 for dev, 19001 for prod.
- APP 0.1.34/build33 adds early native Java/NDK/ANR and Android 11+ exit history,
  installation/session/user attribution, order action names and bounded SDK queue.
  Phone/native/offline acceptance is user-run; synthetic ingress is not that test.

Do not stop the old Windows GlitchTip or its tunnel: production still uses it.
Monitor cloud disk space; diagnostics are intentionally bounded and symbols use S3.

## Scope and status

Only development. Production API, database, APP releases and monitoring stay unchanged.
APP -> Sentry SDK persistent transport -> dedicated Sentry -> signed service hook -> API summary.
Full payloads/stacks stay in Sentry; API receives an allowlisted diagnostic projection.

- [x] Inspect existing SDK, API and server resources.
- [x] API signature verification, idempotent persistence, admin-only read API and tests (8 passing).
- [x] APP initialization/privacy/native-plugin changes and unit tests (7 passing); native build verification pending.
- [ ] Separate local Docker deployment, pinned Sentry version and private ingress.
- [ ] Connect dev Sentry project to dev API; verify real delivery and retry.
- [ ] New dev APK with matching source maps; native/offline crash validation.

## Infrastructure constraints

2026-09-21: cloud server 2 CPU / 4 GB RAM / 15 GB free disk: do not install Sentry there.
Local workstation has sufficient host RAM/disk, but WSL is capped at 8 GB / 4 CPUs.
Existing local API/Kafka/PostgreSQL containers are running. Raising the WSL memory
limit requires a Docker/WSL restart and explicit approval for that interruption.
User approved increasing WSL RAM to 24 GB and restarting Docker. Applied; prior
local containers restarted. Backup: `%USERPROFILE%/.wslconfig.before-sentry-20260921`.

Use official getsentry/self-hosted release 26.9.0, `errors-only` profile (no tracing,
profiling or session replay). Dedicated Compose project and volumes; do not reuse
API PostgreSQL, Redis or Kafka. Never bypass the upstream memory checks.
Use a loopback listener, TLS ingress for SDK ingestion, and private admin access.
The ingestion path must proxy to Sentry, not the ordinary JSON API and not JWT auth.
No tokens/passwords/document bodies/location data in reports or logs.

## Acceptance

Verify a handled JS exception, fatal JS exception, native Android crash and offline
crash followed by restart/reconnection. Confirm readable source frames, exact APK /
OTA identity, one API event per Sentry event ID, rejection of forged hooks, and
denial of event reads to non-admin users. Native crash QA requires a new APK and a
device/emulator; a synthetic webhook alone does not prove crash capture.
