# Help latency measurements

`metrics.performance.version=1` is an additive, bounded snapshot in the existing
assistantState. It adds no event, query, inference call or independent timer.
AsyncLocalStorage isolates simultaneous worker attempts. Only counters and
elapsed times are collected; no tool arguments, results, prompts or credentials.

- `attemptElapsedMs`: monotonic elapsed time since this worker attempt started.
- `jobAgeAtStartMs`: age of the job, including any earlier attempts/backoff/manual
  retry. This is **not queue wait**.
- `readyDelayMs`: time since this attempt's `nextAt`. Includes scheduler/lease
  recovery delay; an expired running lease is not distinguishable from a queue.
- `jobElapsedMs`: age at start plus monotonic current attempt duration.
- `firstDraftProducedMs`: first nonempty draft offered to the progress callback.
- `firstDraftPersistedMs`: first successful fenced progress transaction containing
  a draft. Appears on the next normal state write or completion; it is not client
  delivery/render latency. Nonstreamed answers may have no draft samples.
- `stages`: knowledge retrieval, model round (HTTP + body/stream + awaited progress
  persistence), compaction, 1C, application, history, file creation, upload. Counts,
  total/max milliseconds and `thrownErrors` describe measured calls. JSON error
  results are not thrown exceptions; outcome/error activities remain authoritative.

A model duration is not pure inference time. Stages exclude authorization and
other orchestration outside the measured operation; their sum is not an end-to-end
latency guarantee. First draft need not be the final answer. Existing publication
fences still apply. Completion is measured when the final state is prepared inside
its transaction, not when a device receives it.

`node scripts/help-performance/report.cjs 24` reads the last 24 hours (1–168), at
most 1000 final OpenAI jobs. It reports separate completed/error p50/p95, sample
counts, cap and missing-metric count, never dialogue or IDs. Only the latest attempt
per job is retained; historical attempts are not reconstructed. Old jobs remain
without metrics. No automatic DB migration/backfill or public endpoint is added.

Run it inside the authorized dev API container with its existing private config.
Do not copy the env to a report. `node --test scripts/help-performance/test_report.cjs`
and `help.performance.unit.test.ts` verify aggregation, independent worker slots,
monotonic durations, retries and exception preservation.
