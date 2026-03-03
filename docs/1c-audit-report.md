# 1C Integration Audit Report

Date: 2026-03-03

## Scope
This audit covers:

- `/api/1c` routes wired in `src/index.ts`
- 1C validation schemas, controllers, OpenAPI comments, and sync journal models
- Marketplace consumer routes and services that depend on imported 1C catalog, pricing, stock, and order status data
- Current testability blockers that affect this integration path

This report reflects the current branch state, including the hardening changes applied in this pass.

## Changes Applied In This Pass

- Restricted `POST /api/1c/orders/:guid/ack` to accept only `SENT_TO_1C` when `status` is supplied.
- Made `results[].key` deterministic and collision-safe for `product-prices` and `special-prices` when `guid` is absent.
- Added `jest.unit.config.ts` and a `test:unit` script for isolated mock-based route tests that do not need the global DB bootstrap.
- Added a local `exceljs` type declaration and a unit-test stub so `tsc` and isolated route tests can run in this workspace.
- Synced the implemented endpoint list in `docs/1c-sync-implementation-prompt.md` with the actual `/api/1c` router.
- Added focused unit tests for the tightened ack contract and composite batch keys.

## Findings

### Critical

None confirmed after the hardening changes in this pass.

### High

- `GET /api/1c/orders/queued` returns a much richer payload than the guide and OpenAPI example document. The controller returns full order relations and line details, while the docs describe a minimal queue shape. This is still an active contract-drift risk.
  Files: `src/modules/onec/onec.controllers.ts`, `src/modules/onec/onec.routes.ts`, `docs/1c-import-guide.md`
- `DeliveryAddress` and `ProductPackage` can still be created without `guid`, which means repeated imports of the same logical row can create silent duplicates because the fallback path uses `create`, not a stable upsert key.
  Files: `src/modules/onec/onec.controllers.ts`, `prisma/schema.onec.prisma`
- `POST /api/marketplace/orders` validates pricing and context consistency but does not enforce stock availability before queuing an order. If stock reservation is a business requirement, this is a missing validation step.
  Files: `src/modules/marketplace/marketplace.service.ts`
- The default `npm test` path still uses `jest.config.ts`, which always runs `__tests__/setup.ts` and still requires a live `DATABASE_URL`. The new `test:unit` path mitigates this for isolated tests, but the main test path remains infra-coupled.
  Files: `jest.config.ts`, `__tests__/setup.ts`, `src/prisma/client.ts`

### Medium

- Batch imports run large sequential loops inside a single transaction. This is safe for atomicity but likely to produce long transaction windows and growing lock time under large payloads.
  Files: `src/modules/onec/onec.controllers.ts`
- `resolveEffectivePrice` loads candidate `SpecialPrice` and `ProductPrice` rows into Node.js memory and filters/sorts them in application code. This scales poorly when price history grows.
  Files: `src/modules/marketplace/marketplace.service.ts`
- `createOrder` performs per-item product lookup, optional package lookup, and per-item price resolution. This is an N+1 query pattern that will become a hot path for large carts.
  Files: `src/modules/marketplace/marketplace.service.ts`
- `isActive=false` acts only on rows present in the incoming batch. There is no "missing rows become inactive" reconciliation pass, so imports do not currently support snapshot-style deactivation.
  Files: `src/modules/onec/onec.controllers.ts`
- `sourceUpdatedAt` is persisted, but imports do not guard against stale updates overwriting newer data. Current behavior is last-write-wins.
  Files: `src/modules/onec/onec.controllers.ts`

### Low

- The prompt doc was stale and has been partially corrected in this pass, but the rest of the narrative sections should still be re-reviewed against the expanded implementation.
  Files: `docs/1c-sync-implementation-prompt.md`
- The 1C test suite is still thin; coverage now includes nomenclature plus two focused contract checks, but the rest of the 1C surface remains mostly untested.
  Files: `__tests__/onec.nomenclature.test.ts`, `__tests__/onec.contracts.unit.test.ts`

## Route Contract Matrix

### 1C Routes

| route | auth | input source | zod schema | controller output | OpenAPI shape | docs shape |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /api/1c/nomenclature/batch` | `secret` in body | `req.body` | `nomenclatureBatchSchema` | `{ success, count, results[] }` | matches batch envelope | guide aligned |
| `POST /api/1c/warehouses/batch` | `secret` in body | `req.body` | `warehousesBatchSchema` | `{ success, count, results[] }` | matches batch envelope | guide aligned |
| `POST /api/1c/counterparties/batch` | `secret` in body | `req.body` | `counterpartiesBatchSchema` | `{ success, count, results[] }` | matches batch envelope | guide aligned |
| `POST /api/1c/agreements/batch` | `secret` in body | `req.body` | `agreementsBatchSchema` | `{ success, count, results[] }` | matches batch envelope | guide aligned |
| `POST /api/1c/product-prices/batch` | `secret` in body | `req.body` | `productPricesBatchSchema` | `{ success, count, results[] }` | matches batch envelope | guide aligned |
| `POST /api/1c/special-prices/batch` | `secret` in body | `req.body` | `specialPricesBatchSchema` | `{ success, count, results[] }` | matches batch envelope | guide aligned |
| `POST /api/1c/stock/batch` | `secret` in body | `req.body` | `stockBatchSchema` | `{ success, count, results[] }` | matches batch envelope | guide aligned |
| `GET /api/1c/orders/queued` | `secret` in query | `req.query` | manual parsing | `{ success, count, orders[] }` with rich order graph | example is minimal queue payload | guide example is minimal and narrower than code |
| `POST /api/1c/orders/:guid/ack` | `secret` in body | `req.params + req.body` | `orderAckSchema` | `{ success, acknowledged, status? , error? }` | now needs enum note for `SENT_TO_1C` only | guide allows `status`; should be narrowed to export-ack semantics |
| `POST /api/1c/orders/status/batch` | `secret` in body | `req.body` | `ordersStatusBatchSchema` | `{ success, count, results[] }` | matches batch envelope | guide aligned |
| `GET /api/1c/sync/runs` | `secret` in query | `req.query` | manual enum parsing | `{ success, count, runs[] }` | matches OpenAPI | guide aligned |
| `GET /api/1c/sync/runs/:runId` | `secret` in query | `req.params + req.query` | manual parsing | `{ success, run }` | matches OpenAPI | guide aligned |

### Marketplace Consumer Routes

| route | auth | input source | zod schema | controller/service output | OpenAPI shape | docs shape |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/marketplace/products` | bearer token | `req.query` | `listProductsQuerySchema` | `successResponse(items, meta)` | route comment matches high level | no external doc; route comments are canonical |
| `GET /api/marketplace/products/:guid` | bearer token | `req.params + req.query` | `productGuidParamsSchema` + `stockQuerySchema` | `successResponse(product)` | route comment matches high level | no external doc |
| `GET /api/marketplace/products/:guid/stock` | bearer token | `req.params + req.query` | `productGuidParamsSchema` + `stockQuerySchema` | `successResponse(stock)` | route comment matches high level | no external doc |
| `GET /api/marketplace/prices/resolve` | bearer token | `req.query` | `resolvePriceQuerySchema` | `successResponse(resolved)` | route comment matches high level | no external doc |
| `POST /api/marketplace/orders` | bearer token | `req.body` | `orderCreateSchema` | `successResponse(order)` | route comment matches high level | no external doc |
| `GET /api/marketplace/orders` | bearer token | `req.query` | `ordersListQuerySchema` | `successResponse(items, meta)` | route comment matches high level | no external doc |
| `GET /api/marketplace/orders/:guid` | bearer token | `req.params` | `orderGuidParamsSchema` | `successResponse(order)` | route comment matches high level | no external doc |
| `GET /api/marketplace/me/context` | bearer token | request context | none | `successResponse(context)` | route comment present earlier in file | no external doc |
| `PUT /api/marketplace/me/context` | bearer token | `req.body` | `meContextUpdateSchema` | `successResponse(context)` | route comment present earlier in file | no external doc |
| `GET /api/marketplace/me/counterparty` | bearer token | `req.query` | `includeInactiveQuerySchema` | `successResponse(counterparty)` | route comment present earlier in file | no external doc |
| `GET /api/marketplace/me/agreements` | bearer token | `req.query` | `includeInactiveQuerySchema` | `successResponse(items, meta)` | route comment present earlier in file | no external doc |
| `GET /api/marketplace/warehouses` | bearer token | `req.query` | `includeInactiveQuerySchema` | `successResponse(items, meta)` | route comment present earlier in file | no external doc |

## Validation and Output Notes

- `onecAuthMiddleware` reads `secret` from `req.body.secret` first, then `req.query.secret`.
- If `ONEC_SECRET` is unset, every `/api/1c` route returns `401 Unauthorized`; there is no explicit startup guard for a missing secret.
- `nullableDate` treats `null`, `undefined`, and `''` as omitted values, then coerces everything else to `Date`.
- `orders/status/batch` allows any `OrderStatus`, which is correct for the import-from-1C path.
- `orders/:guid/ack` is now intentionally narrower and only accepts `SENT_TO_1C` when `status` is supplied.
- Marketplace outputs consistently convert Prisma `Decimal` values to plain numbers before returning JSON.

## Data Integrity and Idempotency Review

- `Product`, `ProductGroup`, `Warehouse`, `Counterparty`, `ClientContract`, `ClientAgreement`, `PriceType`, `ProductPrice`, `SpecialPrice`, and `StockBalance` all use stable upsert paths.
- `ProductPackage` and `DeliveryAddress` lose idempotency when `guid` is missing, because the fallback path is `create`.
- Nullable unique `guid` columns (`String? @unique`) do not help rows where `guid` is omitted, so null-guid rows rely entirely on alternative unique keys or create-only behavior.
- Composite upsert keys for `ProductPrice` and `SpecialPrice` match the Prisma schema and are now also reflected in the generated `results[].key`.
- There is no stale-write guard based on `sourceUpdatedAt`; imports currently trust arrival order.

## Scalability Review

### Immediate bottleneck

- None confirmed as an immediate failure point for small-to-moderate batch sizes, assuming current traffic remains low.

### Acceptable now, refactor before growth

- Sequential per-item work inside a single transaction for all batch imports in `src/modules/onec/onec.controllers.ts`.
- In-memory candidate filtering and ranking in `resolveEffectivePrice`.
- Per-item query fan-out in `createOrder`.
- Large `orders/queued` payloads, because the export endpoint returns nested relations for every queued order.

### No change required

- Core uniqueness constraints for `StockBalance`, `ProductPrice`, and `SpecialPrice` support deterministic upsert behavior.
- `SyncRun` and `SyncRunItem` have the minimum indexes needed for current list/detail access patterns.
- `Order` has usable indexes for `status`, `queuedAt`, and `sentTo1cAt` for queue-style reads.

## Testability and Verification Plan

### Contract Tests Present

- `__tests__/onec.nomenclature.test.ts`
- `__tests__/onec.contracts.unit.test.ts`

### Contract Tests Still Missing

- Happy-path, validation, and unauthorized coverage for the remaining 1C endpoints
- `404` tests for `order ack`, `orders status`, and `sync run detail`
- Composite-key collision tests for `special-prices`
- End-to-end marketplace tests for pricing resolution, stock reads, and order lifecycle around 1C-backed data

### Infra Blockers

- `npm test` still requires a working `DATABASE_URL` because the default config runs `__tests__/setup.ts`.
- `src/prisma/client.ts` still throws at import time when `DATABASE_URL` is absent.
- The new `test:unit` path stubs `exceljs` to avoid unrelated runtime module resolution failures during isolated route tests.

### Recommended Verification Commands

- `npm run test:unit -- __tests__/onec.nomenclature.test.ts __tests__/onec.contracts.unit.test.ts`
- `npm run type-check`
- `npm test` only in an environment with a valid `.env.test` and reachable test database

## Remediation Backlog

### Quick wins

1. Align the `orders/queued` docs and OpenAPI examples with the real payload, or intentionally shrink the payload.
2. Add contract tests for the remaining 1C routes using the new `test:unit` path where possible.
3. Document that `ONEC_SECRET` missing at runtime causes all `/api/1c` routes to return `401`.

### Contract fixes

1. Decide whether `orders/queued` should remain rich or become minimal, then freeze one canonical shape.
2. Decide whether null-guid `DeliveryAddress` and `ProductPackage` imports are allowed in production; if yes, define a stable fallback key, otherwise require `guid`.
3. Re-review `docs/1c-sync-implementation-prompt.md` beyond the endpoint list and sync the narrative with the current implementation.

### Performance fixes

1. Preload reference maps once per batch and chunk large writes instead of holding one long transaction for very large payloads.
2. Push price filtering closer to SQL or add narrower lookup queries for `resolveEffectivePrice`.
3. Batch preload products, packages, and effective-price inputs in `createOrder`.

### Test-infra fixes

1. Split unit and integration tests formally in CI and run `test:unit` without DB.
2. Make the default `__tests__/setup.ts` bootstrap conditional, or introduce a second integration-only config as the default for DB-backed suites.
3. Keep `jest.unit.config.ts` module stubs isolated so the main runtime dependency graph is not silently masked in integration tests.
