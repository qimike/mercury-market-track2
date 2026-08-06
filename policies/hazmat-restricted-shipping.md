---
policyId: POL-DRONE-HAZMAT
version: "1"
title: Hazmat / restricted-shipping category return rule
region: ALL
skuScope: ELECTRONICS-DRONE
effectiveDate: 2025-06-01
expirationDate: null
returnWindowDays: null
returnable: false
precedence: 2
supersedes: []
provenance:
  owner: Logistics & Safety Compliance
  approvedBy: Head of Logistics
  lastReviewed: 2025-06-01
---

# Hazmat / restricted-shipping category return rule (v1)

Products classified as restricted-shipping (lithium battery / hazmat,
including consumer drones) are **non-returnable once delivered**, regardless
of any regional return window, due to carrier hazmat handling restrictions
on the return shipping leg.

## Conflict note

This document does not declare precedence over `POL-RETURN-EU` or any other
regional return policy — it is a separate, carrier-safety-driven lineage.
When a drone SKU order originates from a region with its own return policy,
`evaluate_policy` must report the conflict rather than resolving it silently.
Resolving this class of conflict is a deliberate business decision, not an
engineering one — do not add a `supersedes` entry here without sign-off from
both Logistics & Safety Compliance and the relevant regional Legal team.

## Change history

- v1 (2025-06-01): Initial hazmat restricted-shipping rule.
