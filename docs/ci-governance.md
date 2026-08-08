# CI governance

## Deterministic checks (always run, never skipped)

`src/governance/deterministicChecks.ts`:

- **`checkPolicyCatalog()`** — duplicate `(policyId, version)` pairs,
  missing/invalid effective-date ordering, unsupported region codes, broken
  `supersedes` references, missing source-file provenance — run against the
  actual runtime `policyCatalog` (`src/mock-backends/data.ts`), not a
  re-parse of the markdown, so a bug in what the system would actually load
  is what gets caught.
- **`checkPermissionConfiguration()`** — asserts `ADVISOR_ALLOWED_TOOLS` and
  `HUMAN_EXECUTION_ONLY_TOOLS` (`src/domain/roles.ts`) never overlap.
- **`checkApprovalHashes()`** — asserts every recorded approval's
  `suggestionHash`/`actionHash` is a well-formed 64-character hex digest.

Findings are fingerprinted (`buildFingerprint`, `src/domain/schemas/ciReview.ts`)
from stable, semantic properties (rule reference, normalized path, category,
normalized evidence) — never raw line numbers alone — so a finding survives
an unrelated reformat.

## Model-assisted checks — honest current limitation

`src/governance/ciReview.ts`'s `runModelAssistedReview` attempts a
`claude -p <prompt> --output-format json` invocation, but **only if `which
claude` (or `where claude` on Windows) succeeds first** — it is never
assumed available. **In the sandbox this system was developed in, the
`claude` CLI is not installed** (`which claude` returns "command not
found"), so this path has only been exercised as "gracefully skipped," never
as a real end-to-end model-assisted run. The exact flags used are taken from
the spec's own description of "capabilities comparable to `-p`,
`--output-format json`" — they are not independently verified against
`claude --help` in this environment. If you have the CLI installed, run
`npx tsx src/governance/ciReview.ts` and check `modelAssisted` in the output
to confirm it actually ran, before relying on it.

The model-assisted pass is strictly additive: its absence or failure never
turns a `fail` into a `pass`, and its output is discarded (not trusted) if
it doesn't parse as a valid `CiReview` (`parseCiReview`) — malformed output
never silently passes a change.

## Severity gates

`src/domain/schemas/ciReview.ts`'s `DEFAULT_BLOCKING_SEVERITIES = ["blocker",
"high"]`. A review's overall `status` is `fail` if any finding is at or
above a blocking severity, `pass_with_notes` if there are only lower-severity
findings, `pass` if there are none.

## False-positive reduction

See the `mercury://playbook/review-criteria` MCP resource
(`src/mcp/resourceDefinitions.ts`) for the exact criteria: a blocking
finding must have a precise location, concrete evidence, the violated rule,
meaningful impact, an actionable correction, and sufficient confidence.
Wording preferences, formatting-only changes, harmless rephrasing,
equivalent schema descriptions, and duplicate symptoms of the same root
cause must never block.

## Prior-finding comparison and duplicate suppression

`src/governance/ciReview.ts`'s `compareAgainstPrior(current, prior)`
classifies every current finding as `fresh` (new fingerprint), `stillActive`
(same fingerprint as a prior run), or notes which prior findings are `fixed`
(fingerprint no longer present). Results persist to
`.governance/prior-findings.json` (gitignored — regenerated every run, never
hand-edited). A fixed finding that reappears in a later run is reported as
fresh again, not silently re-suppressed — see
`tests/governance/ciReview.test.ts`.

## Plan-first vs. direct-execution classification

See the root `CLAUDE.md`'s "Plan-first vs. direct-execution" section — this
repository does not yet implement an automated changed-file risk classifier;
the distinction is currently a documented human/agent judgment call, applied
consistently with the categories listed there.

## Secret handling and untrusted-PR behavior

`.github/workflows/track2-governance.yml`: `permissions: contents: read`
(no write access anywhere in the workflow), no `ANTHROPIC_API_KEY` is passed
to the workflow at all — a fork-originated pull request therefore always
runs deterministic-only governance, which is sufficient to gate the checks
that matter (policy/permission/hash integrity) even with zero credentials
available.

## Local commands

```bash
npm run governance:ci                    # same as below, via package.json
npx tsx src/governance/ciReview.ts       # run directly
npx tsx src/cli/index.ts governance      # via the demo CLI (prints + compares vs. prior)
```
