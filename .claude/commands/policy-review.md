---
description: Review policy-related changes for version/date/scope/conflict/provenance issues
---

Review the pending policy-related changes (staged/unstaged diffs under `policies/` and
`src/mock-backends/data.ts`'s `policyCatalog`, plus any related change to
`src/mock-backends/policy.ts`'s evaluation logic). If no changes are pending, review the
policy documents and catalog as they currently stand.

Do NOT modify any files during this review unless the user explicitly asks you to apply a fix
afterward. This command is read-only analysis.

Check specifically for:

1. **Version changes** — did `version` increment on every file whose rule content changed?
   Flag any content change with no version bump, and any version bump with no content change
   (both are provenance smells).
2. **Effective dates** — is `effectiveDate` sane relative to when this change is being made? Is
   `expirationDate` (if set) after `effectiveDate`? Does a new policy's `effectiveDate` create a
   gap (no policy covering some date range) or an overlap with the previous version?
3. **Region/SKU scope** — is `region`/`skuScope` as narrow as the actual rule requires? Flag any
   policy using `ALL`/`ALL` for a rule that's actually region- or category-specific — that's a
   scope error, not a global rule.
4. **Conflicts** — for each (region, skuScope) pair touched by the change, list every other
   policy in `policyCatalog` that is also in scope for the same pair and currently/previously
   effective in an overlapping date range. If any of them disagree on `returnable`/return window
   and neither's `supersedes` covers the other, flag it as an unresolved conflict — do not
   suggest which one should win; that's a business decision requiring sign-off from both
   documents' `provenance.approvedBy`.
5. **Rule precedence** — does `precedence` correctly reflect specificity (SKU-specific >
   region-specific > global)? Flag any `supersedes` entry that isn't clearly justified by the
   policy file's own text.
6. **Missing provenance** — flag any policy file or catalog entry missing `provenance.owner`,
   `provenance.approvedBy`, or `provenance.lastReviewed`.
7. **Missing tests** — if the change alters which policy applies to any SKU/region combination
   used by an existing seeded order (`src/mock-backends/data.ts`) or evaluation scenario
   (`src/eval/scenarios.ts`), confirm there's a test or eval scenario that would catch a
   regression. If not, say so explicitly and name the specific test that should be added — but
   do not add it yourself unless asked.

Report findings grouped by the 7 categories above. For each finding, cite the specific file and
policyId/version involved. If everything checks out, say so plainly rather than inventing
findings.
