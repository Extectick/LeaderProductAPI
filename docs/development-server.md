# Development API server

The public development API is served at `https://dev.leader-product.ru`.

- Checkout: `/opt/leader-api-dev`
- Compose file: `docker-compose.server-dev.yml`
- API listener: `127.0.0.1:3001`
- Nginx terminates TLS and proxies the public domain to port 3001.
- PostgreSQL and Redis use dedicated containers and named volumes.
- Kafka infrastructure is shared with production to save memory, but the dev
  API uses a dedicated client id and request topic.
- S3 credentials may be shared, but `S3_ENV_PREFIX=dev` is mandatory.
- Production and development must never share `DATABASE_URL`, JWT secrets,
  `REDIS_KEY_PREFIX`, `KAFKA_CLIENT_ID` or `KAFKA_REQUEST_TOPIC`.

The server `.env` is intentionally not stored in git. It is created from the
production template during initial provisioning, then all environment-specific
values and authentication secrets are replaced.

## WMS15 private connection (2026-09-17)

Cloud dev uses `ONEC_LP_APP_BASE_URL=http://172.20.0.1:16186/WMS15/hs/lp-app`.
This is an internal Docker-bridge address, not a public 1C publication.

Connection path:

```text
leader_api_dev -> 172.20.0.1:16186 (host nginx, dev network only)
              -> 127.0.0.1:16185 (SSH reverse tunnel)
              -> Windows 192.168.30.244, Apache /WMS15
              -> 1c.leader-product.ru, WMS15
```

- Windows task: `LeaderProduct-WMS15-DevTunnel`, runs as SYSTEM at startup.
- Runner and private key: `C:\ProgramData\LeaderProduct\Wms15DevTunnel`;
  access is restricted to SYSTEM and local administrators. Never copy the key
  into this repository. The key owner must be SYSTEM for unattended OpenSSH.
- The runner reconnects after 15 seconds; SSH keepalives detect lost connections.
- VDS SSH account: `leader-onec-dev-tunnel`. No shell, TTY, local forwarding or
  arbitrary reverse listeners: only `127.0.0.1:16185` is permitted.
- VDS nginx config: `/etc/nginx/conf.d/leader-onec-dev-tunnel.conf`.
  Only `/WMS15/hs/lp-app/` is proxied. MCP and other publications return 404.
  HTTP access logging is disabled here because legacy 1C clients may put the
  API key in the query string.
- If the dev Docker subnet changes, update the nginx bind address, allowlist
  and dev API URL together. Do not replace the bind address with `0.0.0.0`.
- Production still uses its existing external `torg2026` publication.

Diagnostics (no secrets printed): inspect the Windows task and its `ssh.log`,
then check VDS listeners 16185/16186 and make an authenticated `/ping` request
from `leader_api_dev`. Use the container's 1C credentials in memory; never echo
them. The public dev `/health` checks API infrastructure, not the 1C tunnel.

After changing only the dev `.env`, recreate only the API container:

```sh
cd /opt/leader-api-dev
docker compose -f docker-compose.server-dev.yml up -d --force-recreate --no-deps --pull never api
```

Deployment backups on the VDS:

- `/opt/leader-api-dev/.env.before-wms15-tunnel-20260917` (root-only);
- `/etc/ssh/sshd_config.before-wms15-dev-20260917`.

Before switching to another 1C database, review live caches and persisted
offline datasets separately. Do not delete orders, tracking data or Redis
volumes as a cache-reset mechanism. During this switch the dev Redis contained
only a rate-limit key. The WMS15 outbound exchange settings register was empty;
setting up full outbound/offline exchange is a separate step.

Verification on 2026-09-17:

- `/health`, authenticated API `/api/1c/lp-app/ping`, client-order reference
  data and a bounded order-list request returned HTTP 200.
- Killing only the dedicated VDS tunnel connection was followed by automatic
  reconnection from the Windows task; a subsequent WMS15 ping returned 200.
- Production API container start time was unchanged.
- APP dev OTA commit `38300d14a4bc70ad3f2e8389c2afbc09989b8094`, runtime
  `0.1.30`, update ID `913aff18-8207-4080-b07a-431f359a3eb0`; workflow
  `35174959635` completed successfully. No APK rebuild was required.

### WMS15 extension applied (2026-09-17)

Live version: `2026-09-01-offline-drafts-v50`. Source
`OneC/МатрицаЗакупокИПродаж` was loaded and platform `/CheckConfig` reported no
errors. Initial application was blocked by a thin-client session. After explicit
user authorization, only WMS15 sessions were terminated: Страховенко АА and the
system background job. The already validated extension was applied using the
standard deployment script's functions; source files had not changed since the
successful compilation.

Access and scheduled jobs were temporarily blocked only for WMS15, then restored
in `finally`. Confirmed `sessions-deny=off`, `scheduled-jobs-deny=off`, and cleared
temporary maintenance message/deadline. Temporary RAS was stopped afterwards.
Cloud dev API `/api/1c/lp-app/ping` confirms v50; direct 1C `/organizations` and
`/nomenclature?limit=1&offset=0` returned HTTP 200 through the tunnel.

For future maintenance, launch a temporary RAS against
`1c.leader-product.ru:1540` (this run used local port 1547), not the unrelated
existing local RAS service. Always re-resolve exact base identity before changes.
Observed WMS15 UUID: `f010e776-316b-4b9c-b99b-4cb5bf16d06b`, cluster UUID:
`e21ac94e-1926-419f-9663-40bf173541fc`. These are not permission to terminate
sessions without user approval. Do not touch other bases in this cluster.

Deployment logs are under workspace `.tmp/onec-extension-update`: validation
timestamp `20260917-083601-097`, successful application
`МатрицаЗакупокИПродаж-apply-authorized-20260917.log`.
