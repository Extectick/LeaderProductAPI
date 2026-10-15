# Order snapshot delivery receipts (v63)

`POST /api/1c/orders/snapshot/batch` preserves its legacy HTTP and `success`,
`count`, `results[].key/status/error` fields. HTTP 200 means the batch was
processed, not that every order was applied.

The additive `receiptVersion: "order-snapshot-receipt-v1"` contract includes:

| outcome | status | applied | retryable | Meaning |
| --- | --- | --- | --- | --- |
| applied | ok | true | false | Snapshot committed. |
| duplicate | ok | true | false | This exact snapshot is already committed; no revision, lines or order events changed. |
| deferred | ok | false | true | A local order edit/export is pending. Keep the 1C outbox item. |
| rejected | error | false | depends | Validation/conflict/stale versions are permanent; missing catalog references remain retryable. Keep diagnostics; do not call it a successful delivery. |

The sender must require `success === true` and exactly one result matching the
expected app order GUID. Delivery is confirmed only when that result has
`status === "ok"` and `applied === true`. Missing, ambiguous or malformed results
are not confirmations. Old servers without the applied field require explicit
compatibility handling; do not silently treat an HTTP 200 as delivery.

`currentRevision` identifies the API revision when available; `code` provides a
machine-readable rejection/defer reason. Retries of an uncertain transport must
reuse the same snapshot, including revision and source timestamp. A callback
retry is not permission to recreate or repost the 1C order.

Late explicit revisions and older source timestamps are rejected without
turning a healthy current order into a conflict. Exact accepted replays are
idempotent, including legacy snapshots with implicit revision. Normal revision
conflicts and pending local edits retain their existing content protections.

Duplicate acknowledgement requires the latest committed
`ONEC_ORDER_SNAPSHOT_APPLIED` event for the current revision to contain the same
canonical parsed payload. `last1cSnapshot` alone is not evidence: it also stores
rejected/deferred payloads and direct-worker ACKs. Exact missing-product snapshot
retries may recover an import `ERROR` after catalog synchronization, but only at
the original identity/revision and without modifying the failed payload. Pending
local edits, uncertain exports, cancellations and unrelated errors remain protected.

Focused verification:

```powershell
npm run test:unit -- --runInBand __tests__/onec.orderSnapshotRecovery.unit.test.ts __tests__/onec.orderWriteSafety.unit.test.ts __tests__/clientOrdersExportRetry.unit.test.ts __tests__/clientOrdersExportIntegrity.unit.test.ts
npx tsc --noEmit
```
