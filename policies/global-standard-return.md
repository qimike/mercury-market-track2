---
policyId: POL-RETURN-GLOBAL
version: "3"
title: Global standard return policy
region: ALL
skuScope: ALL
effectiveDate: 2026-01-01
expirationDate: null
returnWindowDays: 30
returnable: true
precedence: 0
supersedes: []
provenance:
  owner: Global Policy Team
  approvedBy: VP Customer Experience
  lastReviewed: 2026-01-01
---

# Global standard return policy (v3)

Items may be returned within **30 days of delivery** for a full refund,
unless a region-specific or SKU/category-specific policy states otherwise.

This is the fallback of last resort: `evaluate_policy`
(`src/mock-backends/policy.ts`) only applies this document when no
more-specific region or SKU policy is in scope for the request — a
region-specific general rule or a SKU-specific rule always takes precedence
in consideration, even if that more-specific rule has since expired (see
`policies/CLAUDE.md`, "Stale policy is not a gap the global policy fills").

## Change history

- v3 (2026-01-01): Reconfirmed 30-day window company-wide.
