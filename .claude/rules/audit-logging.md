# Audit logging rules

- Audit records are append-only — `src/mock-backends/caseManagement.ts`'s
  case-event log, `src/mock-backends/approvalQueue.ts`'s escalation/approval
  queues, and `src/approvals/store.ts`'s approval records must never gain an
  update-in-place or delete path.
- `src/audit/auditLog.ts`'s timeline must keep customer statements,
  retrieved facts, advisor analysis, deterministic validation, policy
  review, human decisions, tool execution, and execution results
  distinguishable from each other — don't collapse them into one generic
  "event" kind.
- Never log secrets, full payment-card data, passwords, private
  chain-of-thought, or unnecessary identity evidence. If a new field might
  contain any of these, redact it before it reaches a log, audit record, or
  scratchpad entry.
- Every consequential claim in an escalation packet or suggestion packet
  must trace back to a provenance entry from an actual tool call — never an
  asserted fact with no source.
- Correlate on stable identifiers (caseId, sessionId, suggestionId, actionId,
  toolCallId, correlationId) — not on volatile things like line numbers or
  array indices.
