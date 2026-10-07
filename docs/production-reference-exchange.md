# Production reference exchange — 2026-10-08

## Scope and safety

User authorized initial and recurring outgoing `torg2026 -> production API`
reference, price and stock exchange. Business documents, order import and the
production extension configuration are not changed. No WMS15/dev data is copied.

Production API: `d76204a`, pinned image. 1C LP App protocol:
`2026-10-07-offline-delivery-addresses-v53`.

Before initial upload a second custom-format PostgreSQL backup was saved at
`/var/backups/leader-reference-sync-20261008/production.dump`. Archive listing
verified, SHA-256:
`54b3c9d4ffae81d174176325037f13372a049d6473077b4026cf74382c0465b4`.
The earlier release backup/restore check and rollback image remain intact.

## Root cause and setup

- Production 1C outbound BaseUrl/Secret were empty; no outgoing scheduled jobs
  existed. The mutation queue accumulated records but nothing sent them.
- Before repair API had only 439 counterparties, no selling prices, no personal
  reserves, no offline policy and no offline dataset state.
- Set BaseUrl to `https://api.leader-product.ru`, loaded the production exchange
  credential directly in memory, validated schema 1.4.0, BatchSize 500,
  ClearBeforeExport false. Credentials are not stored in this document/scripts.
- Registered the missing selling-prices and manager-stock exchange modules.
- Initial per-row queue preparation was cancelled only for our own bootstrap
  job; completed entities retained. Remaining queues were prepared transactionally
  in batches and sent through `ВыполнитьИсходящуюОчередь`.
- The first price drain also hit the existing per-batch whole-register copy cost.
  Its own run was stopped between acknowledged batches. The remaining 46,344
  prices and 420 reserves used the same installed 1C HTTP import method in
  <=500-row / 384 KB batches. Queue/snapshot acknowledgements were grouped in
  <=10,000-row transactions, checking payload hashes under an entity lock so a
  concurrently changed row would remain queued. No installed module was edited.
- Foundation session: `cmuynw1k800b001pgpmvaby7v`. No replace-mode clearing.
- Independent Marketplace `inventory` / `images` queues are outside this work.

## Verified evidence

- All 11 outgoing entity queries execute successfully.
- 8,100 source counterparties received; 11,030 current delivery addresses match
  the import payload by counterparty + address GUID and full address, zero missing
  or different values. Historical inactive address rows remain in API.
- Manager scopes for users 43, 100, 38 match live 1C exactly: 827, 196, 196;
  no extra or missing counterparties.
- 25 imported selling prices and their source priority match live 1C.
- Static outbound guards and XML validation passed; no order-import method is
  called by the three outgoing scheduled procedures.
- Foundation session resolved 54,326 / 56,476 staged rows, no apply errors.
  2,150 rows were BLOCKED due to excluded references: 197 stale nomenclature
  queue rows, 1,902 cost rows for excluded products, 34 contracts and 17
  agreements linked to deleted counterparties. Read-only 1C classification
  checked every referenced GUID: 2,080 products excluded from current export
  (including two deletion-marked) and 21 deletion-marked counterparties.
  No currently exportable reference was found among these blocked dependencies.
  Do not restore excluded products/deleted customers merely to clear a journal.

## Completion checklist

- [x] Complete all 65,844 selling prices and 420 personal reserve rows.
- [x] Compare current 1C keys with received data for every entity.
- [x] Enable only three outgoing production jobs; verify actual scheduler runs.
- [x] Enable CLIENT_ORDERS_OFFLINE_ENABLED after source verification.
- [x] Read all 11 device datasets and unchanged deltas for three real managers.
- [x] Publish the separately verified production APK 0.1.33/build32 and verify
  the permanent download link, if all release readiness checks pass.

## Final live result

- Source key coverage: nomenclature 3,407 (including groups), organizations 4,
  warehouses 2, counterparties 8,100, contracts 17,984, agreements 18,911,
  cost rows 5,123, selling prices 65,844, stock rows 2,424, reserves 420. Every
  source key reached API; unresolved excluded/deleted dependencies are listed
  above, not silently counted as applied. Special prices are empty in 1C.
- API preserves historical rows and therefore total DB counts are not expected
  to equal current source counts. Production users/orders remained 98/5,692.
- All 11 HTTP snapshots and empty post-snapshot deltas verified for users
  100, 37, 93. Customer counts: 196/181/141; addresses: 316/300/413;
  prices: 12,350/7,934/13,428; personal reserves: 82/0/3. Total server-side
  read times including projection generation: 9.9/5.7/8.2 seconds, not phone QA.
- `order-options` is empty in the installed outgoing payload. Current APP
  payment/delivery selectors use built-in choices, so these controls do not
  depend on nonempty order-options. No synthetic 1C values were inserted.
- Catalog HTTP pagination: 2,361 unique products, equal to the current
  three-month source policy, zero missing/out-of-scope products.
- After the actual scheduled stock refresh, all 11 dataset epochs/revisions for
  user 100 stayed unchanged: unchanged values do not force a full download.
- Queue job ran 04:33:38–04:34:16 and 04:34:38–04:34:41; stock job ran
  04:33:38–04:34:10 (1C server local time), no background exceptions. Last
  exchange phases COMPLETED, zero errors. LP App queues empty; independent
  Marketplace queues untouched. First scheduled night is 2026-10-09 and has
  not occurred at verification time.
- Offline delivery enabled by recreating only the API container with the same
  pinned image. Health DB/Redis/S3 passed.
- APK AppUpdate id 14 is active on prod, version 0.1.33/build32. Permanent URL
  `https://api.leader-product.ru/download` returns this release; full 129,526,385
  byte download and SHA-256 match the previously verified artifact. No new OTA
  was published. Install over the current app without deleting local drafts.

## Recurring operation

Use `OneC/scripts/configure-lp-prod-outbound-jobs.bsl` only after successful initial
upload. It requires the exact torg2026 database and production API target:
queue every 60 seconds, stock/reserves every 300 seconds, full source reconciliation
at 02:15–02:16 (server local time). First full nightly run starts on the next day
when installation is after that window. The full scan only queues changed rows
and tombstones. Do not enable legacy `ВыполнитьОчередь`: it also imports orders.

Large first loads are slower than steady-state changes: current queue code copies
an entity record set on batch acknowledgement. Optimizing that implementation
would require a separate reviewed extension update; none was done in this task.
Phone/Android E2E checks remain separate from API/1C verification.
