# Policy document conventions (policies/)

Path-scoped addition to the root `CLAUDE.md`. Files here are the source-of-
truth policy documents; `src/mock-backends/data.ts`'s `policyCatalog` array
is a hand-synced mirror of them for the mock backend to serve. **If you edit
one, edit the other in the same change** — a real deployment would generate
`data.ts` from these files, but the mock keeps them separate for simplicity.

## Every policy file MUST have front-matter with:

- `policyId` — stable identifier, never reused for a different rule.
- `version` — string, increments on any rule-content change.
- `region` — `ALL` or a specific region code (see `SUPPORTED_REGIONS` in
  `src/domain/config.ts`).
- `skuScope` — `ALL` or a specific SKU/category token.
- `effectiveDate` / `expirationDate` (nullable) — ISO dates.
- `returnWindowDays`, `returnable`, `precedence` — see
  `src/mock-backends/policy.ts`'s `PolicyDocument` type for exact semantics.
- `provenance.owner` / `provenance.approvedBy` / `provenance.lastReviewed` —
  who is accountable for this rule. Never merge a new policy file without
  these — an ungoverned policy is worse than no policy.

## Conflict detection is deliberate, not a bug to fix

`evaluate_policy` will report `decision: "undetermined"`, `confidence:
"low"`, and a `conflicts` entry whenever two in-scope, currently-effective
documents disagree and neither's `supersedes` list covers the other. This is
correct behavior — do not "fix" a failing conflict test by adding a
`supersedes` entry unless a human with actual authority over both documents
(see their `provenance.approvedBy`) has decided the precedence. Adding
`supersedes` is a business decision recorded in a policy file, not a code
fix.

## Stale policy is not a gap the global policy fills

If the only document scoped to a given region+SKU has expired and no
successor exists, `evaluate_policy` reports `undetermined`/`low` rather than
silently falling back to `POL-RETURN-GLOBAL` (see the scoping rule in
`src/mock-backends/policy.ts`: any more-specific document in scope excludes
the fully-global ALL/ALL fallback from consideration, even after it
expires). If you're renewing an expired policy, publish a new file/version —
don't rely on the fallback to "cover" a lapsed rule.

## Tests required when policy content or logic changes

- Adding/editing a policy file: add or update a case in
  `src/mock-backends/data.ts` if it changes evaluation behavior for an
  existing seeded order, and re-run `npm run eval` — a policy change that
  silently flips an eval scenario's expected outcome must be caught, not
  waved through.
- Changing `evaluatePolicy`'s scoping/precedence/conflict logic: add a unit
  test in `test/policy.test.ts` for the specific scenario the change is
  meant to fix, in addition to the existing conflict/staleness tests.
