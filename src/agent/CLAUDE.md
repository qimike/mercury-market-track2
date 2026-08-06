# Agent loop conventions (src/agent/)

Path-scoped addition to the root `CLAUDE.md`. This is the highest-blast-radius
part of the codebase — bugs here can mean an unverified customer's order gets
read, or a refund executes when it shouldn't.

## Non-negotiables

- `hooks.ts`'s `runPreToolHooks` is the ONLY place identity/threshold/
  idempotency enforcement may live. Do not duplicate or "helpfully"
  reimplement a check inline in `loop.ts`, `subagentLoop.ts`, or a subagent —
  it will drift. If a new side-effecting tool needs a check, add it here.
- `loop.ts`'s `finalize()` must always leave a case in an auditable terminal
  state (`resolved` or `escalated`) — if you change termination handling,
  keep the fail-safe escalation path (`fileFailSafeEscalation`) intact for
  every safety-valve reason (max iterations, duplicate-call loop, exhausted
  output retries).
- Semantic validation (`validation.ts`) checks that citations/transaction IDs
  in a structured output actually came from a tool call this case (via
  `CaseContext.seenPolicyCitations` / `seenTransactionIds`). Don't relax this
  to "trust the model's input" — that's exactly the fabrication risk it
  exists to catch.
- A forked session (`session.ts`) connects to MCP with `readOnlySession:
  true`. Never add a code path that lets a fork call a side-effecting tool
  "just this once" — if you need a fork to cause a side effect, that's a
  sign it shouldn't be a fork.

## When changing thresholds or retry/iteration limits

Read them from `src/domain/config.ts`, never hard-code a number here. If a
test asserts a specific threshold value, update the test's expectation
alongside the config change, in the same commit, with a reason.

## Testing this directory

`test/loop.test.ts`, `test/hooks.test.ts`, `test/validation.test.ts`, and
`test/coordinator.test.ts` are the primary coverage. Any change to
`loop.ts`'s control flow (iteration limits, duplicate detection, terminal
tool handling) needs a test that would fail without the change.
