# Help application API tools

The assistant previously had profile search and account statistics, not a generic
application API adapter. Ticket 55's request for chat 52 never attempted an API
read. The actual owner (user 1) can manage Help and open chat 52; the model's claim
that chat search was inaccessible described a missing tool, not an HTTP 403.

`helpApplicationTools` now provides:

- `app_get_help_chat`, `app_search_help_chats`: bounded chat discovery through the
  existing `helpActor`, `requireHelpTicket` and list policies, without reading
  messages or advancing read markers. Successful reads register canonical
  `leaderproduct://services/help?ticketId=N` links; invented/history-only links
  do not enter this catalogue. Membership/manager access is rechecked at each
  disclosure and in the final message transaction.
- `app_api_search`, `app_api_operation`: 359 real registered method/path
  operations with route/OpenAPI schema hints. The generator includes mounted
  routers, nested routers and literal loop-generated routes. It does not accept
  model-invented paths or infer that every POST is a write.
- `app_api_call`: calls catalogued JSON operations on the configured internal API
  origin. The server supplies a short-lived JWT for the actual ticket owner;
  user/role/header/token overrides are not accepted. Claims match ordinary APP
  login primary-role permissions. Existing API handlers enforce their normal
  access and input validation. Other transports are identified explicitly in the
  catalogue and use their existing protected forms/specialized tools.

The catalogue covers all registered verbs, rather than a two-command allowlist.
Credential/session flows, uploads, binary streams, internal webhooks and
operations with downstream shared-account 1C writes are marked separately.
Help `request-it`/`claim` keep the existing user button and confirmation policy.
This adapter does not remove APP authorization, provide passwords to the model,
change account roles, or replace personal 1C authorization.

## Calls and publication

Arguments/response sizes are bounded. URLs are constructed solely from a known
operation template, encoded path parameters and query scalars. Redirects are
rejected. Authorization never enters model data; credential fields, JWTs, signed
private URLs and diagnostic internals are filtered from JSON responses. Real
HTTP 401/403/404 and business errors remain distinguishable from missing tools.

Mutation execution uses a Redis receipt keyed by owner, originating chat turn
and normalized operation arguments. Uncertain writes remain non-repeatable;
completed retries return only execution status, never the previous private
resource payload. Receipts include the caller access fingerprint and reject
replay after permission changes. Changing generated client idempotency IDs does
not create a second write. No real mutation is performed by the rollout probe.

Actor role/department/permission snapshots are rechecked before disclosure and
inside the existing final transaction. Knowledge API reads additionally retain
source/document/version/ACL metadata under share locks and recheck it before
publication. Normal administrative draft access remains possible; published
reads preserve publication/freshness/revocation fences. No document text is
retained in these private validation receipts.

The broker signs `helpApi:true`. Auth middleware establishes a request-local
AsyncLocalStorage context only after JWT verification. Both shared LP HTTP
transports reject an actual live request before reading keys/Basic credentials.
Normal APP requests/background workers and cached APP reads remain unchanged.
A fixed internal response header communicates a blocked read-through even when
legacy handlers mask the error. The broker preserves successful cached data with
an explicit freshness note; fresh 1C requests use the existing personal tools.
The intentional 422 does not open the global LP circuit breaker.

## Development delivery

APP link taps use the existing Help route and save the originating draft through
its normal screen switch. Only Metro source changes were made; no OTA is to be
published while the owner is developing through Metro.

The API/worker image is a scoped layer over the actual
`leaderproductapi:help-user-context-dev-20261105-r1` image, preserving its requester,
page/version/participant context, product links, personal tools, lease/source
fences and earlier HTML/Office/OTA changes. Private runtime patch/source/probe
proofs: `.dev-runtime/help-app-api-20261105/`. No dependencies, migrations,
production services, T3 lifecycle, Metro lifecycle or databases are replaced.

Active dev image: `leaderproductapi:help-app-api-dev-20261105-r1`. Both API
and worker are healthy; 56 runtime module hashes were checked in each process.
Checks: 295 API tests, 30 additional existing LP regressions, 57 APP tests and
TypeScript passed. The runtime smoke test covers tool dispatch, exact link
provenance, the complete operation catalogue and the verified-JWT shared1C guard.

A real Sol/medium repeat of ticket 55's original request under its actual owner
(user 1) called `app_get_help_chat` and returned the exact confirmed link to 52.
A separate ordinary JSON profile API read also succeeded under the same actor.
The dialogue message hash was unchanged, no business mutations were allowed in
the probe, and no OTA was started or published.
