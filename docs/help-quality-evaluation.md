# Help dialogue and evidence evaluation

This evaluation checks a fixed, synthetic set of dialogue regressions against the
actual `requestOpenAIAnswer` adapter. It is separate from the scheduled learning
review. It does not read tickets, change its cursor/SQLite state, promote issues,
write knowledge, deploy code or change the in-app model.

## What is covered

`scripts/help-quality/cases.cjs` contains 10 authored scenarios, 12 total turns:

| Scenario | Trusted expectation |
| --- | --- |
| Warehouse then period correction, three turns | Preserve the unchanged condition; use the newest correction |
| Short confirmation | Interpret “yes” against the preceding proposal |
| Return from protected 1C form | Recall the task without asking for the same parameters |
| New task cancels old task | Do not carry obsolete conditions forward |
| IT departure | State the observed departure without inventing its cause or a new handoff |
| Partial result | Do not present a two-row portion as the full database total |
| Narrow access result | A single read permission and unknown write permission do not prove administrator rights |
| Irrelevant instruction | An existing citation does not prove a rule absent from its excerpt |
| Instruction embedded in source | Document text cannot grant privileges |
| Generated JSON evidence | Preserve zero/negative values, incomplete results and an unknown total |

Names, dates, IDs, sources and dialogue are invented for these tests. Do not copy
real tickets, employee identities, connection details, attachments or credentials
into this directory. The source-injection example is intentionally untrusted
fixture content, not an instruction for the evaluation runner.

Each next turn receives the **actual preceding adapter answer**. The expected
answer and checks stay on the evaluator side and are never sent to the provider.
For the IT case only, a synthetic server event and participant context are supplied.
No application, personal 1C, history, people, Office or HTML tools/adapters are
provided. Thus these tests cannot call business APIs or write business records.
They test reasoning over supplied evidence, not real 1C authorization/network
readiness, ticket ACLs, file storage/download or mobile rendering.

## Offline checks

Use the workspace Node 24 environment and run from `LeaderProductAPI`:

```sh
node --test scripts/help-quality/test_evaluate.cjs
npm run test:unit -- --runInBand --runTestsByPath __tests__/help.quality-evaluation.unit.test.ts
node scripts/help-quality/run.cjs --fixtures
```

The first command tests the checks themselves, including deliberately wrong
answers. The Jest suite passes injected Responses envelopes through the real
adapter's serialization, validation and output parser, with external fetch
forbidden. `--fixtures` reports `fixture-harness-only`: passing it demonstrates
fixture consistency, **not** a model-quality result.

## Explicit real development evaluation

Real calls require an explicit opt-in and the current compiled development
adapter at `dist/modules/help/help.openai.js`. Compile the candidate source before
running, and record its revision/hash outside the report when comparing releases.
A test against stale dist does not validate current source. Do not replace live
containers merely to execute this evaluation.

Run in the already configured private development environment with the normal
OpenAI key file and scoped proxy. Never put a key in a command line, fixture,
checked-in env file or report. These exact nonsecret flags are required:

```text
HELP_QUALITY_REAL=1
NODE_ENV=development
HELP_AI_ENABLED=true
HELP_AI_PROVIDER=openai
HELP_OPENAI_ENABLED=true
HELP_OPENAI_MODEL=gpt-6.1-sol
HELP_OPENAI_REASONING_EFFORT=medium
HELP_OPENAI_ALLOW_GENERAL=true
KNOWLEDGE_ENABLED=true
```

Then run a bounded subset or the full suite:

```sh
node scripts/help-quality/run.cjs --real --cases=warehouse-correction,partial-not-empty
node scripts/help-quality/run.cjs --real
```

The CLI refuses real execution before loading the adapter if opt-in/configuration
is missing. Runs are sequential, with a 12-minute suite deadline; normal adapter
request timeouts and bounded contract repair remain in force. The full suite has
12 logical answer turns; provider retries/repair may add requests. This mode incurs
normal provider charges. It is never called by the offline CI command. Sol/medium
is the application evaluation model, independent of the scheduled Sol/high analyzer.

Output contains only case IDs, booleans, fixed failure codes, durations and
counters. Answer text, excerpts, request bodies, credentials and exception stacks
are not emitted or persisted. Failed calls are `PROVIDER_OR_CONTRACT_FAILURE`;
configuration/deadline errors exit 2, failed checks exit 1, successful checks exit 0.
If the global deadline expires before completing the suite, exit 2 is not a
partial success. Review source assertions before changing expected results.

## What a pass proves

The semantic checks are trusted, authored and bounded: expected current
conditions, forbidden stale values/unsupported claims, expected uncertainty,
question counts, citation presence and exact JSON evidence values. A second model
does not grade itself. Tests deliberately show that a schema-valid answer with a
valid source ID can still fail the evidence checks.

These checks are not universal natural-language entailment. They can reject a
correct paraphrase or miss a differently worded false claim. A pass covers the
listed examples only; it does not certify every answer or justify automatically
marking a learning issue VERIFIED. When improving coverage, add an explicit
negative example that previously passed as well as a supported positive example.
Do not weaken privacy, access validation, lease checks or publication review to
make an evaluation pass.

## Bounded production contract proposal (not enabled here)

For future production grounding, prefer machine-checkable evidence descriptors
for narrow claims over an extra model critic on every reply. A claim could carry
`kind`, source/tool-result ID, object/base scope, completeness and the exact value
being asserted. Deterministic validation can then reject an overall total from a
truncated page, global rights inferred from one object, unknown values promoted
to true, or a claim with no live authorized evidence ID. Keep these descriptors
private and bounded, and validate source revision/authorization before persistence.

Checking a source ID exists does not establish that prose is entailed by its
excerpt. General company-policy claims still need careful retrieval and human
review, with additional adversarial eval cases. No runtime critic or new claim
schema is installed by this change.
