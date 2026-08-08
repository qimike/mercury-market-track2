# Human approval workflow

## States

`SuggestionPacket.humanDecision.status` (`src/domain/schemas/suggestionPacket.ts`):
`pending` | `approved` | `approved_with_changes` | `rejected` | `revision_requested`.

`ProposedAction.executionStatus`: `not_requested` | `awaiting_approval` |
`approved` | `rejected` | `executed` | `failed`.

## Versions and hashes

Every `SuggestionPacket` has a `suggestionVersion` and a `suggestionHash`;
every `ProposedAction` inside it has its own `actionVersion` and
`actionHash`. Both hashes are SHA-256 over **canonical (sorted-key) JSON**
of the object's substantive content (`src/domain/schemas/canonicalJson.ts`)
— explicitly excluding `createdAt`/timestamps, so re-serializing identical
content at a different moment never changes the hash, but any real content
change always does.

## What counts as a material change

`src/approvals/decide.ts`'s `editAction` compares `actionType` and the
entire `parameters` object (canonical-JSON equality) — every material field
the spec calls out (customer reference, order id, line-item ids, amount,
currency, reason, remedy, policy reference, execution target) lives inside
`parameters` in this model, so this one comparison covers all of them. A
truly no-op edit (identical content resubmitted) is a no-op: it does not
bump the version or invalidate approval.

## Invalidation and revalidation

A material edit:

1. Increments `actionVersion` and recomputes `actionHash`
   (`recomputeActionHash`).
2. Recomputes `suggestionHash` (since it's derived over the packet's action
   hashes) and increments `suggestionVersion`.
3. Resets `executionStatus` to `awaiting_approval` and sets
   `humanDecision.status` to `revision_requested`, clearing
   `approvedActionHashes` for the edited action.
4. Does **not** delete the old approval record — it simply can no longer
   match `src/mcp/authorization.ts`'s hash check, so it can never authorize
   execution again.

A fresh `approveAction` call against the new hash is required before
execution can proceed.

## Authorized execution

`src/approvals/execute.ts` is the only code in the repository that ever:

- opens an MCP connection with `callerRole: "human_support_agent"`, and
- calls `process_refund` or `create_return`.

Before calling either tool, it re-fetches fresh backend data
(`get_payment_history`) and reruns amount/currency/balance checks
(`src/approvals/revalidate.ts`) — it never trusts the suggestion packet's
cached numbers, since time may have passed since the packet was built.

`src/mcp/authorization.ts` independently requires, on that connection:

- an on-file approval record matching `suggestionId`/`actionId`,
- `suggestionHash`/`actionHash`/`suggestionVersion`/`actionVersion` all
  matching exactly,
- `forkedFromSessionId === null` (a fork-recorded approval can never
  execute), and
- `executedAt === null` (an already-executed approval is refused, not
  silently re-run — the replay guard).

## Idempotency

`execute.ts` derives `process_refund`'s `idempotencyKey` deterministically
as `${caseId}:${actionId}:v${actionVersion}` — never a model- or
caller-supplied value. `src/mock-backends/payments.ts` additionally
guarantees that replaying the same key returns the original transaction
rather than creating a duplicate.

## Risk-tiered approval count

`src/approvals/riskGate.ts` classifies a proposed action as `standard`
(1 approval required) or `high` (2 approvals required) based on identity
verification, policy confidence, and whether the amount is at/above
`MERCURY_REFUND_LIMIT_USD`. This is advisory bookkeeping on top of — never a
substitute for — the hash/role checks above.

## Audit requirements

Every approve/edit/reject/revise call updates the packet's `humanDecision`
in place (reviewer reference, timestamp, comment) and, for edits, appends a
correction note. `src/audit/auditLog.ts` surfaces the full decision +
execution timeline per case, sourced from the approval store and the
escalation/approval queues — never reconstructed from prose.
