# Agent loop conventions (src/agent/)

Path-scoped addition to the root `CLAUDE.md`. This is the underlying
deterministic engine the advisor runs on (`src/advisor/orchestrator.ts` is
the public entry point) — reused from the Track 1 baseline but rewritten so
there is no autonomous-execution terminal state anywhere in it.

## Non-negotiables

- **This directory's connections are always `advisor_agent`.** Nothing in
  `src/agent/` ever opens a `human_support_agent` MCP connection — that
  happens exclusively in `src/approvals/execute.ts`. If you find yourself
  wanting to execute a side effect from inside a subagent or the
  coordinator, that's a sign the design is wrong, not that you need a new
  exception.
- `hooks.ts`'s `runPreToolHooks` is advisor-side, defense-in-depth
  fail-fast logic — it is NOT the authoritative enforcement boundary. The
  authoritative boundary is `src/mcp/authorization.ts` plus role-scoped tool
  registration in `src/mcp/server.ts`. Do not move authorization logic back
  into `hooks.ts` "for convenience" — it must stay reachable only from a
  `human_support_agent` connection.
- `loop.ts`'s `finalize()` must always leave a run in an auditable terminal
  state (`resolved` = suggestion packet submitted, or `escalated`) — if you
  change termination handling, keep the fail-safe escalation path
  (`fileFailSafeEscalation`) intact for every safety-valve reason (max
  iterations, duplicate-call loop, exhausted output retries).
- Semantic validation (`validation.ts`'s `validateSuggestionPacket`/
  `validateEscalationPacket`) checks that citations/amounts in a structured
  output actually came from a tool call this case (via `CaseContext.
  seenPolicyCitations`), that every "eligible"/"partially_eligible" issue
  cites at least one policy, that proposed amounts don't exceed the known
  refundable balance, and that two proposed actions don't target the same
  order (duplicate compensation). Don't relax any of these to "trust the
  model's input."
- A forked session (`session.ts`) connects to MCP with `readOnlySession:
  true`. Never add a code path that lets a fork call a side-effecting tool
  "just this once."
- The Resolution specialist (`subagents/resolution.ts`) only ever has
  `get_payment_history` in its `allowedMcpTools` — it must never gain
  `process_refund`/`create_return` access. Its output
  (`ProposalFindingSchema`) is a proposal, never a transaction record.

## When changing thresholds or retry/iteration limits

Read them from `src/domain/config.ts`, never hard-code a number here. If a
test asserts a specific threshold value, update the test's expectation
alongside the config change, in the same commit, with a reason.

## Testing this directory

`tests/scenarios/*.test.ts` (full coordinator runs via `FakeClaudeClient`),
`tests/unit/validation.test.ts`, and `tests/unit/authorization.test.ts` are
the primary coverage. Any change to `loop.ts`'s control flow (iteration
limits, duplicate detection, terminal tool handling) needs a test that would
fail without the change.
