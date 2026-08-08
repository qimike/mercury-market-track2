# Policy content rules

- Every policy document requires a source, version, region/SKU scope, and
  effective date; expiration date is required if the policy is not
  open-ended.
- `policies/*.md` and `src/mock-backends/data.ts`'s `policyCatalog` are
  hand-synced (see `policies/CLAUDE.md`) — a change to one requires the
  matching change to the other, in the same commit.
- No silent policy-meaning change: a change to eligibility, window length,
  or precedence needs an updated version number and a fixture/test update
  that would fail without the change.
- Conflicting, unresolved policies must never be silently resolved by
  precedence guessing — `evaluate_policy` returns `decision: "undetermined"`
  and preserves both citations; do not "fix" this by picking a winner in
  code.
- Corresponding test updates are required for any policy content change —
  see `tests/governance/deterministicChecks.test.ts` for the automated
  catalog checks (duplicate identifiers, date ordering, broken references).
