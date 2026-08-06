# Mercury Market — Agent-First Customer Resolution Platform

This file governs how Claude Code should work in this repository. It is read
alongside path-scoped `CLAUDE.md` files in `src/mcp/`, `src/agent/`, and
`policies/`, which override/extend this file for their subtrees.

## What this project is

A customer-support resolution agent for a mocked ecommerce retailer
("Mercury Market") that autonomously handles returns, billing disputes,
account issues, refund requests, order issues, and policy questions — and
knows when to hand a case to a human instead of guessing. See `README.md`
for the full architecture writeup; this file is about how to work *in* the
code, not what the code does.

## Architecture at a glance

- `src/domain/` — framework-free types: `Money` (integer minor units, never
  floats), the structured `ToolError`/`ToolResult` model, zod schemas for
  every structured output, and environment-driven `config` (thresholds).
- `src/mock-backends/` — deterministic in-memory CRM/Identity/OMS/Payments/
  Policy/Case-management systems. Seed data lives in `data.ts`; every
  scenario in `src/eval/scenarios.ts` maps to specific seeded records.
- `src/mcp/` — the real MCP server (`@modelcontextprotocol/sdk`): tool and
  resource definitions, registered on an `McpServer`, served over stdio
  (`.mcp.json`) or an in-memory transport (used by the agent itself).
- `src/agent/` — the deterministic agentic loop (`loop.ts`), the smaller
  per-subagent loop (`subagentLoop.ts`), programmatic safety hooks
  (`hooks.ts`), the bounded-retry tool executor (`toolExecutor.ts`), case
  context/provenance (`context.ts`), semantic validation (`validation.ts`),
  session/fork management (`session.ts`), the coordinator (`coordinator.ts`),
  and the four subagents (`subagents/`).
- `src/eval/` — the deterministic "autopilot" fake model (`autopilot.ts`),
  the 13 seeded scenarios (`scenarios.ts`), and the evaluation runner
  (`runEval.ts`, `npm run eval`).
- `src/feedback/` — human-in-the-loop feedback store and the agent-vs-human
  comparison report.

## Why a hand-rolled loop instead of `@anthropic-ai/claude-agent-sdk`'s `query()`

We evaluated the Claude Agent SDK directly. Its `query()` function is
excellent for coding-agent workflows (file edits, bash, Task-tool subagents)
but deliberately hides the per-iteration tool_use/tool_result loop inside the
Claude Code CLI harness — you get a stream of `SDKMessage`s, not a point where
you inspect a response and decide whether to continue. This project's spec
requires exactly that level of control (inspect the response, enforce max
iterations, detect duplicate tool calls, run programmatic hooks before a tool
executes, run semantic validation with bounded correction retries). We
therefore built the loop directly on `@anthropic-ai/sdk`'s Messages API
(`src/agent/claudeClient.ts` + `src/agent/loop.ts`), and implement our own
coordinator→subagent delegation (`src/agent/coordinator.ts`) that mirrors the
Agent SDK's conceptual model (hooks, subagents, sessions, forks) while giving
us the explicit control the spec asks for. We still build a real MCP server
so the tools are usable by any MCP client (including Claude Code itself via
`.mcp.json`).

## Coding conventions

- **Typed models everywhere.** Every tool input/output is a zod schema
  (`src/domain/schemas.ts`, `src/mcp/toolDefinitions.ts`). Never pass loose
  `any`/`Record<string, unknown>` across a module boundary if a typed shape
  already exists for it.
- **Money is never a `number`.** Use `src/domain/money.ts`'s `Money` type
  (integer minor units) and `parseMoney`/`formatMoney`. Decimal strings
  ("42.50") are the only acceptable wire format. Never `parseFloat` a
  monetary amount.
- **Structured errors, not throws, across tool boundaries.** Mock backends
  and MCP tools return `ToolResult<T>` (`src/domain/errors.ts`) — `{success:
  true, ...}` or `{success: false, error: {...}}`. Reserve real `throw` for
  truly unexpected internal bugs, not business-rule failures.
- **Error propagation preserves the original error.** When wrapping a
  lower-level failure, use `propagate()` (sets `cause`), never swallow it.
- **Idempotency for anything money-moving.** `process_refund` requires an
  idempotencyKey and the mock backend must never create a duplicate refund
  for a replayed key. Don't "fix" a failing idempotency test by relaxing the
  replay check — fix the actual bug.
- **No weakening safeguards to pass a test.** If a test for
  `src/agent/hooks.ts`, `src/agent/validation.ts`, or the payments mock's
  balance/currency checks is failing, the fix is almost never to loosen the
  check. Assume the check is correct until proven otherwise.
- **Test coverage.** New tools, hooks, or validators need tests in `test/`
  covering both the success path and at least one structured-failure path.

## Agent architecture rules

- The coordinator (`src/agent/coordinator.ts`) never calls a backend tool
  directly for customer-specific data — it delegates to the four subagents
  (`delegate_to_identity_subagent`, `delegate_to_order_subagent`,
  `delegate_to_policy_subagent`, `delegate_to_refund_subagent`).
- Read-only, independent delegations (Order + Policy) may run in parallel;
  Refund is dependent and side-effecting and must never be parallelized with
  anything, and must never run before Identity/Order/Policy have returned.
  This is enforced in `AgentLoop.executeToolUseBlocks` (sequential whenever
  any tool in a batch is side-effecting) — don't bypass it with a "faster"
  batching hack.
- Programmatic safeguards live in `src/agent/hooks.ts` and run BEFORE a tool
  call reaches MCP. They are not prompts and must not become prompts. If a
  new side-effecting tool is added, add its enforcement here first.
- Every case must end in exactly one of `resolve_case` or
  `escalate_to_human`. If you add a new terminal state, update
  `src/agent/loop.ts`'s `finalize()` fail-safe path too — a run must never
  silently end without an auditable outcome.

## MCP conventions (see `src/mcp/CLAUDE.md` for more)

- One tool, one action, one typed input/output, documented boundaries and
  failure modes. No generic SQL/HTTP escape hatches.
- Read tools never mutate state; side-effecting tools are marked
  `sideEffecting: true` in `toolSpecs` and must be blocked in forked/
  read-only sessions (see `forkGuard` in `toolDefinitions.ts`).

## Security & privacy requirements

- Never expose unmasked customer email/PII beyond what `get_customer`
  already masks. Don't add a tool that searches customers by name/email.
- Never bypass `verify_customer_identity` as the sole path to
  `identityStatus: "verified"`. No tool, hook, or prompt may set it directly.
- Escalation packets and case events are audit records — don't add a
  delete/update-in-place path for them (append-only).

## Escalation rules

See `mercury://playbook/escalation-criteria` (an MCP resource,
`src/mcp/resourceDefinitions.ts`) for the authoritative, versioned list.
Summary: unverified/locked identity, amount at/above the mandatory
escalation threshold, low/conflicting/stale policy confidence, currency
mismatch, balance exceeded, and exhausted tool retries all require
escalation — never autonomous resolution.

## Testing requirements

- `npm test` (vitest) must pass with zero `ANTHROPIC_API_KEY` set — all
  tests use `FakeClaudeClient` or call mock backends/hooks/validators
  directly. If you add a test that needs the live API, gate it behind
  `process.env.MERCURY_ENABLE_LIVE_API_TESTS === "1"` and skip otherwise.
- `npm run eval` must keep passing 13/13. If you change mock data or policy
  logic, update `src/eval/scenarios.ts` expectations deliberately — don't
  adjust an assertion just to make a red run green without understanding why
  it changed.

## Definition of done for a change here

1. `npm run typecheck` clean.
2. `npm test` passes.
3. `npm run eval` still reports the expected pass count (document any
   intentional change).
4. No safeguard (hooks, validation, thresholds) was loosened without an
   explicit instruction from the user to do so.
5. New tools/resources documented with description, boundaries, and example
   usage, consistent with the existing ones in `toolDefinitions.ts`.
