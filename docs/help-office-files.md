# Office files in Help

Help has server-side tools `help_create_spreadsheet` and `help_create_document`.
They use the existing libraries ExcelJS 4.4.0 and docx 9.15.2 to create genuine
`.xlsx` and `.docx` attachments. Microsoft Office, a desktop process, a Codex
skill or a new external MCP service is not required.

Spreadsheets support typed cells, multiple sheets, headers, number formats and
explicit formulas with cached results. Documents support headings, paragraphs,
lists and tables. Existing uploaded documents can be read for subsequent work;
this does not promise preservation of all original layout when regenerating them.

Successful personal 1C query results receive request-local `dataSourceId` values.
The spreadsheet tool can export these rows directly, preserving numeric types
without asking the model to repeat the dataset. Compatible pages can be combined;
partial sources remain explicitly marked partial. Source IDs cannot be reused
across assistant runs. Creating a report does not grant new 1C permissions.

Generated binaries stay server-side and use the normal Help attachment storage,
authenticated download and final publication transaction. Existing lease, ticket,
source and personal 1C authorization checks remain active. Files are exposed only
after successful storage/publication. The output guard checks their rendered
content. Generated files are limited to 8 MiB each; unsupported or oversized
requests fail explicitly rather than silently truncating data.

XLSX input extraction runs in the existing isolated extraction process. It checks
ZIP structure/expansion, rejects macros/ActiveX, reads cached formula results and
does not execute formulas or fetch workbook links. Document input is limited to
10 MiB, extraction to 25 seconds and bounded text output. Existing attachment
owner/ticket checks and stored-content hashes are preserved.

## Dev release, 2026-11-05

Both API and Help worker run `leaderproductapi:help-office-dev-20261105-r2`.
This is a scoped layer over `help41-read-policy-dev-20261105-r2`; it preserves
durable conversation context, personal 1C access, read-only business operations,
the media-generation prohibition and OTA filename fixes. No APP/native/OTA
release or T3/Metro restart was required.

The scoped image installs Office dependencies under `/app/office-node/`, with
top-level links for ExcelJS and docx. Future full builds must include the committed
package/lock changes and all current Help modules; do not replace concurrent Help
changes with an older branch image.

Validation: TypeScript, 187 targeted tests, and 42 protocol/Office tests after the
final outgoing-tool registration correction. Real Sol/medium in synthetic dev
ticket 44 created both formats. Ordinary sync, authorized download, SHA-256,
anonymous 401, workbook formula/cached result, DOCX contents and assistant
attachment read-back passed. The synthetic ticket was closed without staff
notifications; persistent QA user 121 remains active. No business writes occurred.

A read-only replay of ticket 41 through its Excel request produced a real XLSX.
All ten manager names and numeric amounts match the previous conversation;
this verifies export fidelity, not a fresh 1C reconciliation. The original ticket
was not changed. Private proofs/examples are in `.dev-runtime/office-examples/`
at the workspace root, with runner/build logs in `.dev-runtime/help-office-*`.

Upstream libraries: <https://github.com/exceljs/exceljs> and
<https://github.com/dolanmiu/docx>.
