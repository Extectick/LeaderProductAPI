# HTML explanations in Help

`help_create_html` creates a real, private HTML/CSS explanation in an assistant
answer. It is available beside the existing Office tools and can be chosen when
a visual explanation helps, without a separate user confirmation. It does not
enable image/video generation, JavaScript, business writes or additional 1C access.

Input: `title` (1–160 characters), `description` (1–1,200), and at least one of
`compact`/`full`, each `{html, css}`. Each HTML fragment is at most 48,000
characters and each stylesheet 24,000. Compact spans the message width, with an optional fixed height declared in the
outer HTML element's inline CSS (48–1200 px); otherwise it retains the legacy
square layout. Full is an independent responsive page. The APP adds no enclosing border, background
or padding. The model may include its own design elements when appropriate.

The tool produces at most two materials per answer and returns an idempotent
result for repeated identical calls. Successful full materials return the exact
internal URL `leaderproduct://help-html/<UUID>`. Only actual full materials from
the current run enter the link provenance catalogue. Invented and stale HTML
links become plain text. The APP additionally requires the matching attachment
on the same assistant message. Edits read the prior attachment and create a new
material with its own link and consistent compact/full variants.

## Validation and storage

HTML is parsed by sanitize-html 2.18.1 with an explicit passive HTML allowlist.
Active content, forms, images, foreign namespaces, document controls, event
attributes and external navigation are removed. Only fragment anchors remain.
CSS, including inline styles, is parsed by css-tree 3.2.1; external resource
loads, unknown/raw syntax, style-element escapes, binding expressions and
unapproved at-rules fail closed. Custom properties, responsive queries, grid,
flex, gradients and CSS diagrams remain available.

The output advice guard inspects both original markup/styles and decoded
rendered text. htmlparser2 12.0.0 preserves inline word adjacency during this
extraction, so tags and character entities cannot hide prohibited advice.

The stored file is UTF-8 JSON, MIME
`application/vnd.leaderproduct.help-html+json`, named `<UUID>.help-html.json`.
Version 1 contains matching `id`, `title`, `description`, `compact?`, `full?`.
Maximum serialized size is 192 KiB. Publication revalidates the actual bytes;
descriptor filenames are omitted from the ordinary “files attached” suffix.

When the HTML tool is available, the response budget is at least 12,000 tokens
and the complete tool/answer turn has up to 180 seconds. These are upper bounds,
not requested answer length. `HELP_OPENAI_HTML_MAX_OUTPUT_TOKENS` (up to 32,768)
and `HELP_OPENAI_HTML_TIMEOUT_MS` (up to 300,000) configure them independently
of the existing short-answer limits. Model and reasoning settings are unchanged.

Objects use the existing private Help bucket and authenticated download route.
Uploads remain outside SQL under the heartbeat lease, with fresh per-attempt
keys. The final message/attachment transaction retains ticket, owner, source,
personal 1C proof and context revision fences. Losing attempts are cleaned;
uncertain commit acknowledgement never deletes possibly published attachments.
History attachment reads support the custom JSON MIME under the existing
ticket/owner/snapshot/hash limits. No migration is required.

The APP renders local HTML in an inert WebView or sandbox iframe, without
passing authorization tokens or attachment URLs into the document. It also
uses CSP and disables scripts, network/file access and the application bridge.

## Verification

Run the HTML contract/provider tests plus existing file delivery, policy,
history, Office and entity-link regression suites. Production uses Node24's
require(esm); Jest transforms the parser's actual ESM dependencies without mocks.
Check both API and worker health and module hashes after any scoped dev rollout.
An actual model-created attachment, ordinary message synchronization, authorized
download/hash, anonymous denial and APP rendering must be checked separately.

## Dev rollout — 2026-11-05

API and Help worker run `leaderproductapi:help-html-dev-20261105-r2`, a scoped
layer over the active `help-entity-links-dev-20261105-r1` behavior (via HTML r1).
Eight changed runtime modules were hash-verified in both healthy processes;
15 existing modules covering personal 1C, Office, progress, durable context
and OTA asset filenames match the preceding image. Model remains Sol/medium.
Compose, mounts, resource/concurrency settings and unrelated containers are
unchanged. No migration, T3 or Metro restart was needed.

A real Sol/medium call created the requested example in dev ticket 50 for the
persistent QA owner (user 121). Both views and the exact link are present in
the normal synchronized assistant message. The 11,987-byte stored descriptor
passed authenticated download/hash, anonymous 401 and history read-back checks.
No staff notifications or business writes were produced. Earlier failed
synthetic attempts 48/49 were closed; the successful example remains available.
Private proof and source are under `.dev-runtime/help-html-20261105/`.

APP `a7fc5d96fb339ab5f42582b7eb024afe1ab8c071` is published as dev OTA
0.1.46.12, update `ff25258c-48ee-466d-b5f3-1db794c83dcd`, runtime 0.1.46.
Workflow 42015166663 passed; all 53 files/hashes, 52 Metro local asset keys
and release APK Hermes compatibility were checked. The release excludes
concurrent unfinished question, activity, auth and native layout work.

Verification: 251 API tests, 112 tests on the isolated APP release, TypeScript
and Expo Doctor 20/20 passed. Android received the dev update and exposed the
example ticket, but Device MCP then lost connectivity. Its prescribed list/open
retry failed, so native HTML rendering, expansion and gestures remain visually
unverified. No SSH/ADB UI fallback, emulator reset or T3 restart was used.

## Clickable profiles and products

The existing `help_create_html` tool also accepts `entity: {url}`. The URL must
be canonical and confirmed by the current request's entity-link catalogue;
guessed IDs, routes, query parameters and unrelated links fail closed. Entity
materials require `compact`; optional `full` retains independent expansion.
The application routes card taps through the existing entity provider and the
same shared viewer, which checks the current owner's access again.

An entity HTML fragment can use up to two `<img src="help-entity-image" alt="…">`
slots per variant. Other image addresses, srcset and event attributes are removed.
The descriptor stores no photo bytes or signed URL. After authenticated descriptor
loading, the APP requests the entity preview and materializes its bounded raster
inside the inert local document. JavaScript remains disabled; the whole-card
native press target permits ordinary parent scrolling. Missing or unavailable
photos remove the image slot; the layout should supply initials or a neutral
placeholder. Full HTML export embeds only the already authorized raster bytes.

The preview endpoint uses existing profile access or personal 1C object reads.
Product mirrors without a base key require an exact publication match before
using a synced photo. Current WMS15 and torg2026 publications differ, so those
cross-base photographs are deliberately unavailable until a verified source
mapping/image integration exists. No shared-account fallback or image generation
is introduced.

Dev rollout: `leaderproductapi:help-entity-html-dev-20261105-r2` changes only
HTML action bindings and entity previews over the actual app-statistics image.
Both API and Help worker are healthy; 49 runtime modules were hash-checked in
each process. Existing personal 1C, statistics, context, Office, progress and OTA
behavior remains intact. No dependencies, migrations or native modules changed.
The preview also accepts the historical `avatars/` namespace present on imported
profiles, while still reading only exact stored avatar keys from private storage.

Real Sol/medium example: QA owner 121, dev ticket 52, message 1090. Its compact
and full HTML, confirmed profile action, image slot, authenticated descriptor
hash, anonymous denial, history read-back and preview access were verified. The
owner has no avatar, so this example uses initials. Existing raster re-encoding
was tested with real image bytes in unit tests; the available legacy avatar
records did not yield a current readable image during the dev read-only probe.
No profile/1C writes or staff notifications occurred. Private proofs and source
snapshot: `.dev-runtime/help-entity-html-20261105/`. Checks: 260 API tests,
76 tests on the clean APP release, both TypeScript checks, Expo Doctor 20/20.
Device MCP list/open failed, so Android rendering and drag handoff remain
visually unverified.

APP released as dev OTA **0.1.46.17**, runtime 0.1.46, source
`5188d23cbd01d3bad7ca7395c6b99fc90dea1769`, update
`3a42cf09-1c58-4a16-b8e2-294d5d6119c5`. Workflow 42026646330 succeeded.
All 53 asset hashes, 52 Metro lookup keys and release APK Hermes compatibility
were checked. The release preserves the prior portal/session fix and excludes
concurrent unfinished text-streaming, native-layout and header design work.

## Short object replies default to cards — ticket 55

Ticket 55 contained a completed plain Markdown self-profile answer and zero
attachments; HTML display/loading was not involved. Tool availability alone
left the presentation optional. The HTML instructions now prefer compact entity
cards for profile/product requests. A bounded server fallback also creates one
when a successful answer of at most 600 characters contains exactly one freshly
confirmed supported object and no existing HTML. It uses the actual registered
label and identity, never the model's link caption or a historical link alone.
Explicit link-only/without-card requests, long or ambiguous replies, handoffs
and custom existing HTML are preserved. The normal artifact sanitizer, advice
screening and requester/source/lease/final-publication fences still apply.

Dev patch `leaderproductapi:help-card-default-dev-20261105-r1` layers only three
Help modules over the actual requester-context image. No APP/native/OTA change
is needed. Ticket 55's existing message is preserved. Private reproduction,
image and runtime checks are in `.dev-runtime/help-card55-20261105/`.

The API/worker patch is active and healthy; 45 Help module hashes were checked
in both processes. 159 tests and TypeScript passed. A real Sol/medium run with
only “Пришли мой профиль” produced the actual compact card in QA ticket 57,
message 1108; authenticated attachment hash, anonymous denial, history read-back
and entity preview were verified. Failed pre-activation QA attempt 56 was closed.
Ticket 55 was only read; its existing message was preserved. No OTA was started
or published for this fix. The owner now requires APP checks through Metro and
has explicitly asked not to publish OTA.


## Fixed-height compact HTML — 2026-11-05

Model/tool instructions now request one outer HTML element with inline
style="height:Npx" for fixed-height compact materials (48–1200px). compact
JSON remains strictly {html,css}; no new dimension field/version is emitted,
so older installed clients still parse attachments. Current Metro reads that
root height without scripting or DOM measurements. Old rootless/responsive
materials retain square fallback. CSP, sanitization, generated-file checks,
access/lease/context fences and stored attachments are unchanged.

Scoped image leaderproductapi:help-html-height-dev-20261105-r1 extends actual
help-app-api-dev-20261105-r1. Only help.html.js instructions/tool description
changed;806 other JavaScript modules remain byte-identical. API and worker
healthy, module hash verified in both; Compose/env/mounts/model/effort and
unrelated containers unchanged. A real Sol/medium call produced180px HTML
that passed APP parsing/sizing without messages, storage publication or business
writes. Ticket60 was read only; its actual HTML descriptor exists. The missing
chat preview was an APP image-only priority gate, fixed separately in Metro.
No OTA was published by owner request. Proofs .dev-runtime/help-html60/.


## Website anchors — 2026-11-06

The sanitizer permits http/https only for a[href] using allowedSchemesByTag. Global allowedSchemes stays empty; image, CSS URL, script/frame/form restrictions remain. Credentials, backslashes and raw control characters are rejected. The live dev layer changes only help.html.js; preserve all existing runtime modules/private deployment configuration. No message migration or OTA was performed.


## Списки карточек и фото — 2026-11-07

До12 материалов в одном ответе, общий бюджет384КиБ; сервер поддерживает batch items и проверяет каждый entity отдельно. Исторические ключи изображений в настроенном bucket читаются только из точной директории товара с повторной проверкой прав. Нет OTA/native изменения. См. API docs/help-html-card-lists.md и материалы Nextcloud «Карточки ИИ — 2026-11-07».
