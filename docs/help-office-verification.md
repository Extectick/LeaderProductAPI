# Office export verification

`help_create_spreadsheet` reopens the actual XLSX bytes before exposing an
attachment. `help.office-verify` checks ordered sheet names, row/column dimensions,
headers, every typed value, formula expressions/caches, requested numeric formats
and the table's presentation filter range against the validated export contract.
Trailing empty source rows are materialized in the workbook. Zero, negative
numbers, false and literal formula-like strings remain distinct values.

Finite numeric column sums are compared as a secondary check; the primary check
is each cell, so compensating wrong values cannot pass merely because totals agree.
Overflowing aggregate sums are not counted as verified numeric columns. The sums
are serialization checks, not assertions that adding every numeric column is a
meaningful business total. Formula calculations are **not** executed or proved.
The `formulaResultsCalculated: false` field makes that limit explicit. Cached
zero/false results are read through ExcelJS's `result` property; its `value` getter
omits falsy caches. An empty-string cache has an empty-cell representation on read.

Each receipt includes a SHA-256 bound to the verified bytes and bounded counters.
`validateHelpOfficeFile` rejects a proof attached to different bytes. A mismatch,
invalid archive or cancellation prevents exposing the attachment. This is an
in-process integrity proof, not an externally signed attestation.

`basis: server_data` means the expected cells were mapped directly from the
server-held `dataSourceIds`, with requested column selection/order and existing
reference-to-presentation conversion. `complete_received_result` means all rows
of the selected results were transferred and all selected sources explicitly
reported `truncated: false`. It does not prove that the original query covered
the user's whole business request. `partial_or_unknown` preserves both a known
truncation and an absent completeness flag. Combining pages does not remove this
restriction; no automatic deduplication or reordering occurs.

For explicitly supplied sheets, `basis: rendered_input` verifies only the tool
input, not external facts. `sourceCompleteness: not_applicable` avoids implying
source completeness. Both paths return `filtersVerified: false`: a working Excel
AutoFilter range does not prove query predicates, period or organization matches.
The current contract contains no independently trusted request/filter manifest.
Word documents retain their prior structural checks and receive no XLSX proof.

Deployment must carry `help.office-verify.js` together with `help.office-xlsx.js`,
`help.office-tools.js` and `help.office-contract.js`. No new package, provider,
database migration or model call is needed. Reopening is bounded by the existing
200,000-cell/8 MiB builder limits; it adds one XLSX parse and linear cell scan.
Unusual numeric date formats which ExcelJS reads back as a Date instead of the
input numeric value fail verification rather than silently changing the type.

Regression suites use the real ExcelJS package (not the global Jest stub), open
real ZIP/XLSX bytes, and test altered cells/types/dimensions/headers/sheets,
unchanged totals with incorrect cells, byte substitution, empty rows, partial
sources and publication rejection when the serializer returns a different valid
workbook: `help.office-{xlsx,tools,verify}.unit.test.ts`.
