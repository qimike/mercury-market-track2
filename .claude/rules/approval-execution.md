# Approval and execution rules

- A side effect requires all of: a valid suggestion packet, a valid
  proposed action, a human decision, an authorized human actor reference,
  exact approved parameters, a suggestion version+hash, an action
  version+hash, a valid idempotency key, verified prerequisites, and
  successful immediate revalidation (`src/approvals/revalidate.ts`) against
  fresh data — not the packet's cached numbers.
- Material edits (`src/approvals/decide.ts`'s `editAction`: `actionType` or
  anything inside `parameters` — customer reference, order id, line items,
  amount, currency, reason, remedy, policy reference, execution target) 
  always invalidate prior approval, bump the action's version, and recompute
  its hash. A no-op edit (identical content) must NOT invalidate approval.
- `src/approvals/execute.ts` is the only code path allowed to open a
  `human_support_agent` MCP connection or call
  `process_refund`/`create_return`. Do not add a second one.
- Forked sessions never inherit executable approval — an approval recorded
  with `forkedFromSessionId` set must always fail
  `src/mcp/authorization.ts`'s check, unconditionally.
- Approval replay is prevented by `src/approvals/store.ts`'s
  `executedAt`/`executedTransactionRef` fields; an already-executed action
  must be refused, not silently re-run, on a second execution request.
- Never let a human approval bypass an existing business protection
  (balance, currency, policy-effective-date) — approval authorizes a human
  to request execution, not a bypass of the checks that run at execution
  time.
