# Production stock staging retention

The overlay changes one compiled service on the exact November 24 production sale-pricing image. The source is `src/services/onecSyncMaintenanceService.ts`. The release manifest pins the base and the before/after SHA-256 of the runtime artifact. To reproduce the isolated Docker context on the host with the pinned base image:

```sh
python3 deploy/stock-scope-retention/assemble.py /tmp/leader-stock-scope-build
docker build --network=none --pull=false -t leader-api-prod:stock-scope-retention-20261124-r1 /tmp/leader-stock-scope-build
```

Run the PostgreSQL 16 role preparation in `deploy/onec-retention/stock-role.sql` before activating compact mode. Verify a recoverable copy and rehearse the rule against protected rows and balances. Production has an existing API scheduler. Use it for the new policy by enabling `ONEC_STOCK_COMPACT_ENABLED` and retaining the existing `ONEC_SYNC_RETENTION_ENABLED` flag. Keep all other image layers, configuration, and services at their deployed versions. See `docs/onec-sync-retention.md` for scope, limits and rollback.
