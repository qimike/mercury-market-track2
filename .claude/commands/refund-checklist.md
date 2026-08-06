---
description: Review refund-related implementation against the required safety checklist
---

Review the refund-related implementation (`src/agent/hooks.ts`, `src/agent/validation.ts`,
`src/agent/subagents/refund.ts`, `src/agent/prompts/refund.ts`, `src/mock-backends/payments.ts`,
and the `process_refund`/`resolve_case` tool definitions in `src/mcp/toolDefinitions.ts`) — either
against the currently pending diff, or the code as it stands if there is no pending diff.

Do NOT modify any files during this review unless the user explicitly asks you to apply a fix
afterward. This command is read-only analysis.

Walk through this checklist and report a clear PASS/FAIL/UNCLEAR for each item, citing the
specific file and line/function that supports your verdict:

1. **Verified identity required.** Can `process_refund` (or `create_return`) execute for a
   customer whose `identityStatus` is not `"verified"` in `CaseContext`, through any code path?
   Check `hooks.ts`'s `CUSTOMER_PROTECTED_TOOLS` set and `runPreToolHooks`.
2. **Policy eligibility checked before execution.** Does the refund path require a policy
   decision of `eligible`/`partially_eligible` with `confidence: "high"` before calling
   `process_refund`? Check `src/agent/prompts/refund.ts` and whether anything in code (not just
   the prompt) would stop an autonomous refund on `"medium"`/`"low"` confidence.
3. **Amount validation.** Is the refund amount validated as a decimal-safe `Money` value (never a
   float) before it reaches the payment gateway mock?
4. **Currency match.** Is there a check (in `hooks.ts` AND in `payments.ts`, defense in depth)
   that the refund currency matches the order's currency, with a `CURRENCY_MISMATCH` structured
   error on mismatch?
5. **Remaining refundable balance.** Is the refund amount checked against
   `get_payment_history`'s `remainingRefundableAmount` before execution, with a
   `REFUND_EXCEEDS_BALANCE` structured error (not a silent partial refund) on overage?
6. **Threshold enforcement.** Is there a programmatic (not prompt-only) check that blocks amounts
   at/above `config.mandatoryEscalationLimit` from autonomous execution, regardless of what the
   model argues? Check `hooks.ts`'s `runRefundHooks`.
7. **Idempotency.** Does `process_refund` require a non-empty `idempotencyKey`? Is the key
   deterministically derived (not left to the model) in `hooks.ts`? Does replaying the same key
   return the original transaction instead of creating a new one, in `payments.ts`?
8. **Audit events.** Is a refund/return outcome recorded to the case's audit trail (via
   `CaseContext.ingest` / `record_case_event` / the escalation or resolution packet) rather than
   only existing in the model's own text?
9. **Provenance.** Does the resolution/escalation packet's `policyCitations` trace back to an
   actual `evaluate_policy` result for this case (checked in `validation.ts`'s
   `citationsAreTraceable`), rather than trusting whatever the model wrote?
10. **Escalation behavior.** When any of the above checks fail (unverified identity, low
    confidence, threshold exceeded, balance exceeded, currency mismatch, retries exhausted), does
    the code path lead to `escalate_to_human` rather than a silent failure or a best-effort
    partial action?

Summarize with an overall verdict and a prioritized list of any FAIL/UNCLEAR items.
