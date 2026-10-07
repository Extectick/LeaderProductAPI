# Dev crash reporting (Sentry self-hosted)

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
