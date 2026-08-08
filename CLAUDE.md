# Mercury Market Track 2 — Human-in-the-Loop Support Advisor & CI Governance

This file governs how Claude Code should work in this repository. It is read
alongside path-scoped `CLAUDE.md` files in `src/mcp/`, `src/agent/`, and
`policies/`, and the rule files in `.claude/rules/`, which override/extend
this file for their subtrees.

## What this project is

An internal assistant that helps human support agents at a mocked ecommerce
retailer ("Mercury Market") resolve returns, billing disputes, account
issues, and refund requests — by analyzing a case, retrieving authorized
data, evaluating policy, and producing a schema-validated **suggestion
packet** for a human to approve, edit, or reject. **The advisor never
executes a customer-affecting action itself.** Every refund or return is
executed only by a separately authorized human-execution code path, after
explicit approval tied to an exact content hash. CI/CD governance checks
(deterministic first, model-assisted second) gate changes to policies,
prompts, tool descriptions, schemas, and permissions.

This repository was cloned from a separate, now-frozen Track 1 baseline
(`docs/track2-baseline.md` records the exact commit) and rebuilt as a
standalone platform — it is **not** a dual-mode repository, and no runtime
path here resolves a case autonomously.

## Architecture at a glance

- `src/domain/` — framework-free types: `Money` (integer minor units, never
  floats), the structured `ToolError`/`ToolResult` model, `roles.ts` (the
  role/permission table), and `schemas/` (SuggestionPacket, Rationale,
  CiReview, AdvisorCaseFacts, ProposalFinding — all zod, all hash-stamped
  where versioning matters).
- `src/mock-backends/` — deterministic in-memory CRM/Identity/OMS/Payments/
  Policy/CaseManagement/Returns/Ticketing/ApprovalQueue systems. Seed data
  lives in `data.ts`.
- `src/mcp/` — the MCP server (`@modelcontextprotocol/sdk`): `toolDefinitions.ts`
  (tool contracts), `resourceDefinitions.ts` (read-only reference docs),
  `server.ts` (role-scoped tool registration), `authorization.ts` (the
  server-side gate on `process_refund`/`create_return`).
- `src/agent/` — the underlying deterministic loop engine (loop.ts,
  subagentLoop.ts, coordinator.ts, hooks.ts, toolExecutor.ts, context.ts,
  validation.ts, session.ts, the four specialist subagents) — reused from
  the Track 1 baseline but rewritten so there is no autonomous-execution
  terminal state. The advisor's run always ends in exactly one of
  `submit_suggestion_packet` or `escalate_to_human`.
- `src/advisor/` — the advisor-facing entry point (`orchestrator.ts`),
  derived internal `rationale.ts`, and `packetStore.ts` (suggestion-packet
  version history).
- `src/approvals/` — the human decision workflow: `store.ts` (approval
  records), `decide.ts` (approve/edit/reject/revise, hash invalidation on
  material edits), `revalidate.ts` (fresh-data re-check immediately before
  execution), `execute.ts` (the **only** code path that ever opens a
  `human_support_agent` MCP connection or calls `process_refund`/
  `create_return`), `riskGate.ts` (tiered approval-count requirement).
- `src/sessions/` — resume/fork (`index.ts`, re-exporting `src/agent/session.ts`)
  and the typed investigation scratchpad (`scratchpad.ts`).
- `src/audit/` — append-only audit-timeline aggregation (`auditLog.ts`).
- `src/governance/` — deterministic CI checks (`deterministicChecks.ts`) and
  the CI review orchestrator (`ciReview.ts`), including the (environment-
  dependent, gracefully-degrading) model-assisted pass.
- `src/cli/` — the demonstration CLI (`index.ts`).

## The safety boundary — read this before touching anything in src/mcp or src/approvals

`process_refund` and `create_return` are refused **unconditionally** unless
the calling MCP connection is bound to the `human_support_agent` role. A
role is never a value a tool call can set — it is fixed once, at connection
creation time, by trusted server code:

- `src/agent/mcpClient.ts`'s `connectMercuryMcp()` always defaults to
  `callerRole: "advisor_agent"`, and every advisor code path uses this
  default.
- `src/approvals/execute.ts` is the **only** call site in the whole
  repository that ever passes `callerRole: "human_support_agent"`, and it
  does so on a short-lived connection opened only to execute one already-
  approved action.
- `src/mcp/server.ts` doesn't even *register* a tool a role can't call
  (`isToolAllowedForRole`) — an advisor connection's `listTools()` never
  includes `process_refund`/`create_return` at all.
- `src/mcp/authorization.ts` is the second, independent gate: even on a
  `human_support_agent` connection, execution requires an on-file approval
  record whose `suggestionHash`/`actionHash`/version match exactly, was not
  copied from a forked session, and has not already been executed.

**Never** add a code path that lets an `advisor_agent` connection execute a
side effect "just this once," and never let a role be derived from tool
input. If you need to change this boundary, that's a plan-first change (see
below) — write the plan, get it reviewed, and update
`tests/integration/mcpAuthorization.test.ts` alongside the code.

## Coding conventions

- **Typed models everywhere.** Every tool input/output and every artifact
  that crosses a trust boundary (SuggestionPacket, Rationale, CiReview,
  AdvisorCaseFacts) is a zod schema. Never pass loose `any`/
  `Record<string, unknown>` across a module boundary if a typed shape
  already exists.
- **Money is never a `number`.** Use `src/domain/money.ts`'s `Money` type
  (integer minor units) and `parseMoney`/`formatMoney`. Decimal strings
  ("42.50") are the only acceptable wire format.
- **Structured errors, not throws, across tool boundaries.** Mock backends
  and MCP tools return `ToolResult<T>` (`src/domain/errors.ts`).
- **Idempotency for anything money-moving.** `process_refund` requires an
  idempotencyKey; `src/approvals/execute.ts` derives it deterministically
  (`${caseId}:${actionId}:v${actionVersion}`) rather than trusting a
  model-supplied value. Don't "fix" a failing idempotency test by relaxing
  the replay check.
- **No weakening safeguards to pass a test.** If a test for `src/mcp/
  authorization.ts`, `src/agent/hooks.ts`, `src/agent/validation.ts`, or the
  payments mock's balance/currency checks is failing, the fix is almost
  never to loosen the check.
- **MCP output must exactly match its declared `outputShape`.** The MCP SDK
  validates `structuredContent` against the registered output schema with
  `additionalProperties: false` once a client has called `listTools()` —
  returning an extra field (even a useful one) causes a hard rejection at
  the protocol layer. Every handler in `toolDefinitions.ts` must return
  exactly the fields declared in its `outputShape`, no more.
- **Test coverage.** New tools, hooks, validators, or approval-workflow
  changes need tests in `tests/` covering both the success path and at
  least one structured-failure path.

## Suggestion packets, hashes, and approval

Every advisor recommendation is a `SuggestionPacket`
(`src/domain/schemas/suggestionPacket.ts`): versioned, with a
`suggestionHash` and per-action `actionHash` computed over canonical
(sorted-key) JSON of the packet's substantive content — never over
timestamps. A human's approval (`src/approvals/decide.ts`) is bound to an
*exact* hash + version; editing an action's type or any field inside its
`parameters` bumps its version, recomputes its hash, and resets it to
`awaiting_approval` — the prior approval record no longer matches and
cannot authorize execution. See `docs/human-approval.md` for the full
lifecycle.

## Escalation rules

See `mercury://playbook/escalation-criteria` (an MCP resource,
`src/mcp/resourceDefinitions.ts`) for the routing rules, and
`mercury://reference/advisor-permissions` for the permission summary.
Unverified/locked identity, low/conflicting/stale policy confidence,
currency mismatch, a balance/threshold conflict, and exhausted tool retries
all require `escalate_to_human` — never a submitted suggestion packet.

## Plan-first vs. direct-execution

**Plan-first** (write a reviewed plan before implementing): refund-
eligibility or policy-evaluation logic changes, authorization changes
(anything in `src/mcp/authorization.ts` or `src/domain/roles.ts`), MCP tool
contract changes, breaking schema changes, approval-model changes,
session/audit-model changes, broad cross-component refactors.

**Direct execution** (implement directly, with focused tests): typo fixes,
narrow prompt wording improvements, additional few-shot examples, focused
test additions, non-contractual documentation corrections.

## Testing requirements

- `npm test` (vitest) must pass with zero `ANTHROPIC_API_KEY` set — every
  test uses `FakeClaudeClient` or calls mock backends/hooks/validators
  directly. If you add a test that needs the live API, gate it behind
  `process.env.MERCURY_ENABLE_LIVE_API_TESTS === "1"` and skip otherwise.
- `npm run typecheck` must be clean.
- `npm run governance:ci` runs the deterministic (and, if the `claude` CLI
  is present, model-assisted) governance checks locally.

## Definition of done for a change here

1. `npm run typecheck` clean.
2. `npm test` passes.
3. No safeguard (role checks, hash checks, hooks, validation, thresholds)
   was loosened without an explicit instruction from the user to do so.
4. New tools/resources documented with description, boundaries, and example
   usage, consistent with the existing ones in `toolDefinitions.ts`.
5. Tests and docs updated alongside the change, not left for later.

## Protected / generated paths

- `.governance/prior-findings.json` is generated by `npm run governance:ci`
  and gitignored — never hand-edit it.
- `docs/track2-baseline.md` records a point-in-time fact about the Track 1
  clone; do not "correct" it to match later development — if it's wrong,
  that's a sign something about the clone record itself needs fixing, not
  the file's content.
