---
policyId: POL-RETURN-EU
version: "2"
title: EU consumer return policy
region: EU
skuScope: ALL
effectiveDate: 2026-01-01
expirationDate: null
returnWindowDays: 14
returnable: true
precedence: 1
supersedes: [POL-RETURN-GLOBAL]
provenance:
  owner: EU Compliance Team
  approvedBy: EU Legal Counsel
  lastReviewed: 2026-01-01
---

# EU consumer return policy (v2)

Consistent with EU consumer-rights law, customers in EU regions may withdraw
from a purchase and return items within **14 days of delivery** for a full
refund. This explicitly supersedes the global 30-day window
(`POL-RETURN-GLOBAL`) for EU customers.

## Conflict note

This document does **not** supersede SKU/category-specific restricted-
shipping rules (e.g. `POL-DRONE-HAZMAT`). When both apply to the same order,
`evaluate_policy` reports a conflict and confidence `low` rather than
guessing which one wins — see `policies/CLAUDE.md`.

## Change history

- v2 (2026-01-01): Reaffirmed 14-day window under updated EU consumer-rights
  guidance.
