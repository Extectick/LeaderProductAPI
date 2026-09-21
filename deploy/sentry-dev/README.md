# Local dev Sentry

Pinned upstream: https://github.com/getsentry/self-hosted/releases/tag/26.9.0
Clone: `C:\Share\SentryDev`, independent from API Compose. Profile `errors-only`.
Compose project `leader-sentry-dev`, retention 30 days, loopback port 19000,
taskworker concurrency 2. Keep upstream version pinned and record upgrades.

Install with upstream `install.sh --skip-user-creation --no-report-self-hosted-issues
--no-apply-automatic-config-updates` from a Linux environment connected to the
local Docker engine. Do not run against the production Docker context.
The installer needs its bind-mount paths to resolve identically in the Docker daemon.
Windows checkout line endings must be LF for Linux scripts.

The public dev nginx proxies only SDK ingestion via a dedicated reverse SSH tunnel.
Use a dedicated restricted SSH account/key allowing **only** remote loopback
listener 127.0.0.1:19001. Do not reuse the WMS15 key or root credentials.
The local listener is 127.0.0.1:19000; Sentry UI stays local.
`Run-Tunnel.ps1` runs as SYSTEM, with key/known_hosts in the root-only ProgramData
directory. Never commit keys, admin credentials, Sentry CLI auth token or webhook secret.

Create project `leader-app-dev` (platform `react-native`) and service hook
`event.created` to `https://dev.leader-product.ru/integrations/sentry/events`.
API requires APP_CRASH_REPORTING_ENABLED=true, SENTRY_PROJECT_SLUG=leader-app-dev,
SENTRY_EXPECTED_ENVIRONMENT=development, SENTRY_WEBHOOK_SECRET=<service hook secret>.
The hook uses HMAC-SHA256 over the unmodified UTF-8 body, X-ServiceHook-Signature.
Use admin-only GET /admin/crash-events to inspect summaries; SDK user IDs are claims,
not authentication. Keep Sentry event source as truth; webhook delivery isn't an
exactly-once guarantee and its HTTP retry behaviour must be verified before rollout.

For APP builds use the public ingestion DSN, but SENTRY_URL=http://127.0.0.1:19000
for local symbol/map upload. Set SENTRY_ORG/SENTRY_PROJECT and SENTRY_AUTH_TOKEN
only in the build process, never EXPO_PUBLIC_* for a private token. Cloud CI needs
an authenticated SSH forward for symbol uploads while the admin API stays private.
Do not publish a release without corresponding source maps.

Rollback: disable APP_CRASH_REPORTING_ENABLED on dev API; publish dev APP with
Sentry disabled / rebuild for native kill-switch; stop the dedicated tunnel and
Sentry Compose without deleting volumes. Do not remove shared Docker data/caches.
