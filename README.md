# Mercury Market — Agent-First Customer Resolution Platform

An agentic customer-support resolution platform for **Mercury Market**, a mocked mid-sized
multi-region ecommerce retailer. It autonomously resolves returns, billing disputes, account
issues, refund requests, order issues, and policy questions — and knows exactly when to hand a
case to a human instead of guessing.

## The business problem

Mercury Market handles 4,000–10,000 support tickets/day across web and mobile chat. Today:

- First-contact resolution: **58%**
- Average handle time: **12+ minutes**
- Policy application is inconsistent across regions/SKUs
- Refund leakage: **~1.8% of GMV**
- Policy documents change quarterly; support lags behind

This project demonstrates an agent that can safely close the gap on the mechanical, well-defined
slice of that work — eligible low-value refunds, routine returns, policy questions — while
routing anything ambiguous, high-value, or under-verified to a human with a complete,
auditor-ready evidence packet, never a guess.

---

## Architecture

```mermaid
flowchart TB
    subgraph ClaudeCode["Claude Code (this repo)"]
        CLAUDEMD["CLAUDE.md hierarchy"]
        CMDS["/policy-review, /refund-checklist"]
        SKILL["verbose-log-analysis skill"]
    end

    subgraph App["Agent application (Node/TypeScript)"]
        CLI["src/cli.ts"]
        COORD["Coordinator\n(AgentLoop)"]
        ID["Identity subagent"]
        ORD["Order subagent"]
        POL["Policy subagent"]
        REF["Refund subagent"]
        HOOKS["Programmatic hooks\n(identity / threshold / idempotency)"]
        CTX["CaseContext\n(facts, provenance, audit trail)"]
    end

    subgraph MCP["Mercury Market MCP server"]
        TOOLS["10 business tools +\n6 structured-output/finding tools"]
        RES["7 read-only resources"]
    end

    subgraph Backends["Mocked backend systems"]
        CRM[(CRM)]
        IDSVC[(Identity)]
        OMS[(OMS)]
        PAY[(Payments)]
        POLREPO[(Policy repo)]
        CASEMGMT[(Case mgmt)]
    end

    CLI --> COORD
    COORD -->|delegate_to_identity_subagent| ID
    COORD -->|delegate_to_order_subagent\ndelegate_to_policy_subagent\n(parallel, read-only)| ORD
    COORD --> POL
    COORD -->|delegate_to_refund_subagent\n(after identity+order+policy)| REF
    ID --> HOOKS
    ORD --> HOOKS
    POL --> HOOKS
    REF --> HOOKS
    HOOKS --> TOOLS
    COORD --> CTX
    TOOLS --> CRM
    TOOLS --> IDSVC
    TOOLS --> OMS
    TOOLS --> PAY
    TOOLS --> POLREPO
    TOOLS --> CASEMGMT
    COORD -.->|resolve_case / escalate_to_human| CASEMGMT
```

### Why not `@anthropic-ai/claude-agent-sdk`'s `query()` directly?

We inspected both `@anthropic-ai/claude-agent-sdk` (0.3.x) and the base `@anthropic-ai/sdk`
(0.115.x) before writing any code. The Agent SDK's `query()` is excellent for coding-agent
workflows — it wraps the Claude Code CLI itself, giving you Task-tool subagents, hooks, and
session/fork primitives — but it deliberately hides the per-iteration tool_use/tool_result loop
inside that harness. This spec requires exactly the control that hides: inspect each response,
enforce a max-iteration count, detect duplicate tool calls, run programmatic safeguards *before*
a tool executes, and run semantic validation with bounded correction retries.

So the deterministic loop (`src/agent/loop.ts`) is built directly on `@anthropic-ai/sdk`'s
Messages API, with our own coordinator→subagent delegation (`src/agent/coordinator.ts`) that
mirrors the Agent SDK's conceptual model — hooks, subagents, sessions, forks — while giving us
that explicit control. We still expose a **real MCP server** (`@modelcontextprotocol/sdk`) so the
tools are usable by any MCP client, including Claude Code itself via `.mcp.json`. See
`CLAUDE.md` for the fuller version of this reasoning.

---

## The deterministic agentic loop

`src/agent/loop.ts`'s `AgentLoop` implements the loop exactly:

```mermaid
sequenceDiagram
    participant Claude
    participant Loop as AgentLoop
    participant Hooks
    participant MCP as MCP tools

    loop until terminal or max iterations
        Loop->>Claude: messages + tool defs
        Claude-->>Loop: response (text and/or tool_use blocks)
        alt tool_use present
            Loop->>Hooks: runPreToolHooks(name, input, ctx)
            alt blocked
                Hooks-->>Loop: structured error (no MCP call)
            else allowed
                Loop->>MCP: call tool (bounded retry if retryable)
                MCP-->>Loop: ToolResult<T>
            end
            Loop->>Loop: duplicate-call check, CaseContext.ingest()
            Loop->>Claude: tool_result(s)
        else end_turn, no terminal tool yet
            Loop->>Claude: "call resolve_case or escalate_to_human"
        end
    end
    Loop->>Loop: finalize() — fail-safe escalation if not already resolved/escalated
```

1. Send the conversation + tool defs to Claude.
2. Inspect the response.
3. Continue when `tool_use` is present.
4. Execute + validate the requested tool(s) — hooks first, then the real MCP call, then bounded
   retry for retryable errors only (`src/agent/toolExecutor.ts`).
5. Add tool results back into the conversation, **projected** to the fields future reasoning
   needs (`CaseContext.projectForClaude`), never the raw payload.
6. Continue reasoning.
7. Terminate on `resolve_case` or `escalate_to_human` (both schema- and semantically-validated).
8. Enforce `MERCURY_MAX_LOOP_ITERATIONS` (default 12).
9. Detect a tool call repeated 3× with identical arguments and escalate instead of looping.
10. Preserve a full `TraceEntry[]` across iterations for audit/log-analysis.

If the loop hits a safety valve (max iterations, duplicate-call loop, or exhausted
output-validation retries) without a validated terminal call, `finalize()` files a **fail-safe
escalation** built entirely from `CaseContext` — a run never silently ends without an auditable
outcome.

Each of the four subagents runs its own smaller, bounded loop
(`src/agent/subagentLoop.ts`) — same mechanics, narrower tool boundary, and terminates on its own
`submit_*_finding` tool instead of `resolve_case`/`escalate_to_human`.

## Coordinator / subagent model

| Subagent | File | Allowed tools | Responsible for |
|---|---|---|---|
| Identity | `src/agent/subagents/identity.ts` | `get_customer`, `verify_customer_identity` | Lookup, verification, authentication prerequisites |
| Order | `src/agent/subagents/order.ts` | `lookup_order`, `get_payment_history` | Status, line items, delivery, refund-relevant order facts |
| Policy | `src/agent/subagents/policy.ts` | `evaluate_policy` | Interpretation, region/SKU applicability, conflicts, confidence |
| Refund | `src/agent/subagents/refund.ts` | `get_payment_history`, `create_return`, `process_refund` | Eligibility facts, amount validation, execution |

The coordinator (`src/agent/coordinator.ts`) never touches a backend tool directly — it delegates
via four local tools (`delegate_to_*_subagent`). Order and Policy are read-only and independent,
so the coordinator may (and, per its prompt, should) delegate to both **in the same turn** —
`AgentLoop.executeToolUseBlocks` runs them with `Promise.all`. Refund is side-effecting and
dependent, so it is always run alone, sequentially, and only after Identity/Order/Policy have
returned — enforced structurally (any batch containing a side-effecting tool runs sequentially),
not just by prompt instruction.

---

## Programmatic enforcement (`src/agent/hooks.ts`)

Prompts describe intent; these checks are code that runs before a tool call reaches MCP, and no
system prompt can talk them out of running:

- **Identity enforcement** — `lookup_order`, `get_payment_history`, `create_return`,
  `process_refund` all require `identityStatus === "verified"` in `CaseContext`. A locked account
  is blocked outright.
- **Refund threshold enforcement** — amounts at/above `MERCURY_MANDATORY_ESCALATION_LIMIT` are
  blocked from autonomous execution; currency mismatches and amounts exceeding the known
  remaining refundable balance are blocked (defense in depth alongside `payments.ts`'s own check).
- **Policy-confidence enforcement** — `process_refund` is blocked unless `CaseContext.policyDecision`
  is `eligible`/`partially_eligible` **and** `policyConfidence === "high"`, both set only from an
  actual `evaluate_policy` result this case (`errorCode: POLICY_NOT_ELIGIBLE_FOR_AUTONOMOUS_REFUND`,
  category `POLICY_AMBIGUITY`). `resolve_case` re-checks the same condition in
  `validation.ts` before accepting a claimed refund. This is what makes "ambiguous/low-confidence
  policy → mandatory escalation" a code guarantee, not just something the subagent prompts ask for.
- **Idempotency** — every `process_refund` call's `idempotencyKey` is overwritten with a
  deterministic `${caseId}:refund:${orderId}` value before the call — the model's own choice of
  key is never trusted.

## MCP tools and resources

`.mcp.json` registers the server (`npx tsx src/mcp/server.ts`, stdio transport) for any MCP
client, including Claude Code. The agent itself connects over an **in-memory transport**
(`src/agent/mcpClient.ts`) — same server, same tools, no subprocess.

**Business tools** (`src/mcp/toolDefinitions.ts`): `get_customer`, `verify_customer_identity`,
`lookup_order`, `get_payment_history`, `evaluate_policy`, `create_return`, `process_refund`,
`get_case_history`, `record_case_event`, `escalate_to_human`.

**Structured-output / control tools** (same file, same MCP mechanism): `record_case_facts`,
`resolve_case` (coordinator-terminal), and one `submit_*_finding` tool per subagent
(subagent-terminal). Every tool has a typed zod input/output shape, a documented boundary, and at
least one usage example.

**Resources** (`src/mcp/resourceDefinitions.ts`, read-only): policy catalog, policy version
history, regional refund rules, escalation criteria (including live threshold values), supported
regions/currencies, the customer-support playbook, and the tool error taxonomy.

## Structured error model

Every tool returns `ToolResult<T>` (`src/domain/errors.ts`) — never throws across a tool
boundary:

```json
{ "success": false, "error": { "errorCode": "ORDER_ACCESS_DENIED", "errorCategory": "ACCESS", "message": "...", "isRetryable": false } }
```

Categories: `VALIDATION, ACCESS, NOT_FOUND, CONFLICT, RATE_LIMIT, DEPENDENCY, RATE_LIMIT,
TRANSIENT, POLICY_AMBIGUITY, INTERNAL`. Only `RATE_LIMIT`/`DEPENDENCY`/`TRANSIENT` default to
retryable, and `toolExecutor.ts` only retries when `isRetryable` is explicitly true, bounded by
`MERCURY_MAX_TOOL_RETRIES` with exponential backoff. An empty array (e.g. zero prior refunds) is
always `{ success: true, refunds: [] }` — never conflated with a failure.

## Refund rules

Autonomous execution requires **all** of: verified identity, policy `decision` in
{`eligible`,`partially_eligible`} with `confidence: "high"`, matching currency, amount within the
remaining refundable balance, and amount below `MERCURY_MANDATORY_ESCALATION_LIMIT`. Any single
failure routes to escalation — see `mercury://playbook/escalation-criteria`.

## Structured output enforcement

`Case Facts`, `Escalation Packet`, `Resolution`, and each subagent's `Finding` are zod schemas
(`src/domain/schemas.ts`) registered as MCP tool input schemas — Claude **must** emit a matching
`tool_use` to advance, never "please respond in JSON." Decimal-safe `Money` (integer minor units,
`src/domain/money.ts`) is used throughout; amounts are never floats.

## Validation and retry

Two gates, per spec:

1. **Schema** — enforced by the MCP layer itself; a malformed `tool_use` input is rejected with a
   `VALIDATION` error naming the offending field before our handler even runs.
2. **Semantic** (`src/agent/validation.ts`) — cross-field invariants a JSON Schema can't express:
   every policy citation must match one actually returned by `evaluate_policy` this case
   (`CaseContext.seenPolicyCitations`), every `refundTransactionId` must match a real
   `process_refund` result (`seenTransactionIds`), refund amount must be below the mandatory
   threshold, and an amount/transactionId pair must be present together or not at all.

On failure, the loop returns the exact field errors to Claude as a `tool_result` with
`is_error: true` and re-prompts — bounded by `MERCURY_MAX_OUTPUT_RETRIES` — without repeating any
side-effecting call. On exhaustion, the loop fails safe into a fail-safe escalation.

## Context management

`CaseContext` (`src/agent/context.ts`) is the structured state carried across turns: identity
status, customer/order IDs, currency, known remaining refundable balance, every policy citation
and transaction ID actually seen, provenance, tool-failure tallies, and actions taken. Tool
results are **projected** before being re-injected into Claude's context (`projectForClaude`) —
e.g. `evaluate_policy`'s result is trimmed to `citationIds` rather than the full citation object
on repeat turns. The full raw result always stays in `CaseContext.auditTrail`.

## Session and fork management

`src/agent/session.ts`'s `SessionManager` supports new/resume sessions (transcripts keyed by
`sessionId`, replayable into `AgentLoop.run`'s `resumeTranscript` parameter) and forks:

```mermaid
flowchart LR
    MAIN["Main customer session<br/>(case + trace ID)"] -->|forkSession| FORK["Policy investigation fork<br/>(read-only MCP connection)"]
    FORK -->|inspect multiple policy<br/>versions / SKUs| EVAL["evaluate_policy ×N"]
    EVAL --> CONFLICT{Conflict?}
    CONFLICT --> FINDING["Structured PolicyInvestigationFinding"]
    FINDING -.->|mergePolicyFindingIntoParent<br/>(explicit, not automatic)| MAIN
```

A fork shares its parent's `caseId`/`traceId` for correlation but gets a **separate MCP
connection opened with `readOnlySession: true`** — `verify_customer_identity`, `create_return`,
and `process_refund` are refused at the MCP layer itself (`forkGuard` in
`src/mcp/toolDefinitions.ts`), not merely by convention. A fork's findings are never applied to
the parent automatically; `mergePolicyFindingIntoParent` is an explicit, separate step.

## Provenance

Every consequential fact carries a `Provenance` entry: source type/ID, MCP tool name and call ID,
policy ID/version/effective date, retrieval timestamp, and trace ID. Policy citations are
generated by `evaluate_policy` itself (`src/mock-backends/policy.ts`), so a citation can only ever
reference a policy document that was actually retrieved — `validation.ts` cross-checks this
before accepting any `resolve_case`/`escalate_to_human` call.

## Confidence-calibrated routing

`evaluate_policy` returns `confidence: "high" | "medium" | "low"`:

- **High** + verified identity + amount within limits → autonomous resolution may proceed.
- **Medium** → only safe/reversible, low-risk actions (e.g. answering a policy question); no
  autonomous refund.
- **Low**, any policy **conflict**, or **missing provenance** → escalate. Two disagreeing,
  in-scope, currently-effective policy documents are never resolved by guessing — see
  `policies/CLAUDE.md`'s "conflict detection is deliberate."
- **Stale** — a policy whose most-specific-in-scope document has expired with no replacement is
  `undetermined`/`low`, not silently backfilled by the global default (see the scoping rule in
  `src/mock-backends/policy.ts`).

## Human-in-the-loop feedback

`src/feedback/store.ts` records reviewer decisions (approved/modified/rejected, correct
policy/amount/reason, notes) per case. `src/feedback/report.ts`'s `buildComparisonReport()`
compares the agent's actual decision (from `getResolution`/`listEscalations`) against the
reviewer's, computing escalation correctness, refund-amount difference (decimal-safe), and
citation correctness.

---

## Claude Code configuration

- **`CLAUDE.md` hierarchy**: root (architecture, conventions, security/privacy, escalation rules,
  testing, definition of done) → `src/mcp/CLAUDE.md` (tool/resource conventions) →
  `src/agent/CLAUDE.md` (loop/hook/validation non-negotiables) → `policies/CLAUDE.md`
  (versioning, provenance, conflict-handling rules for policy documents).
- **`.mcp.json`**: registers the Mercury Market MCP server with environment-variable expansion
  for thresholds (no secrets required — the mocked tools need no credentials).
- **Commands**: `/policy-review` (read-only review of policy version/date/scope/conflict/
  provenance/test-coverage issues) and `/refund-checklist` (10-point refund-safety checklist with
  PASS/FAIL/UNCLEAR verdicts).
- **Skill**: `verbose-log-analysis` (`.claude/skills/verbose-log-analysis/SKILL.md`) — analyzes
  `logs/<caseId>.jsonl` trace files (written by `src/cli.ts`) for loops, retry storms, failures,
  validation failures, missing results, and ordering bugs, via a forked subagent, returning only a
  compact summary.

---

## Setup

```bash
npm install
cp .env.example .env   # optional — only needed for live-API mode
```

Requires Node 20+. No API key is required for tests, the evaluation suite, or demo-mode CLI runs.

### Environment variables (`.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Only required for `--live` CLI mode |
| `MERCURY_MODEL` | `claude-sonnet-4-5` | Model for live runs |
| `MERCURY_AUTONOMOUS_REFUND_LIMIT` | `150.00` | Soft guidance threshold |
| `MERCURY_MANDATORY_ESCALATION_LIMIT` | `500.00` | Hard programmatic block |
| `MERCURY_MAX_LOOP_ITERATIONS` | `12` | Coordinator/subagent loop cap |
| `MERCURY_MAX_TOOL_RETRIES` | `2` | Bounded retry for retryable tool errors |
| `MERCURY_MAX_OUTPUT_RETRIES` | `2` | Bounded correction retries for structured output |
| `MERCURY_ENABLE_LIVE_API_TESTS` | `0` | Gate for any future live-API tests |

## Running the application

```bash
# Demo mode — no API key, drives a seeded scenario through the real coordinator/hooks/loop stack
npm run agent:cli -- --scenario eligible_low_value_refund

# Live mode — requires ANTHROPIC_API_KEY
npm run agent:cli -- --live "Customer cust_001 wants to return order ord_1001"
```

Every run writes a trace log to `logs/<caseId>.jsonl` for the verbose-log-analysis skill.

## Running the MCP server standalone

```bash
npm run mcp:server
```

Speaks MCP over stdio — connect any MCP client, or reference it from another project's
`.mcp.json`.

## Running tests

```bash
npm test
```

96 tests across 15 files. All use `FakeClaudeClient` or call mock backends/hooks/validators
directly — **no `ANTHROPIC_API_KEY` required**. Covers: loop behavior (continuation, end-turn,
max iterations, duplicate detection), identity/refund/idempotency hooks, MCP schema
validation/error propagation, empty-result-vs-failure, retryable-vs-not, financial arithmetic,
policy effective dates/conflicts/staleness, provenance traceability, session/fork restrictions,
structured-output validation and correction retries, and escalation-packet generation.

## Running the evaluation suite

```bash
npm run eval
```

Runs all 13 seeded scenarios through the real coordinator/subagent/hook stack (deterministic
autopilot standing in for the model) and reports, per scenario and in aggregate: outcome
correctness, escalation-reason correctness, tools used, **forbidden side effects** (a refund
executed on a case expected to escalate), **refund calculation accuracy** (executed amount
matches requested exactly), **policy citation correctness** (every citation traces to an actual
`evaluate_policy` result), the idempotency replay check, and average loop iterations. Currently
**13/13 pass** on every metric.

| Scenario | Expected |
|---|---|
| `eligible_low_value_refund` | resolved |
| `unverified_customer` | escalated |
| `high_value_refund` | escalated |
| `policy_conflict` | escalated |
| `order_not_found` | escalated |
| `no_previous_refunds` | resolved |
| `transient_payment_failure_then_success` | resolved |
| `retry_exhaustion` | escalated |
| `duplicate_refund_idempotency` | resolved (+ idempotency replay check) |
| `refund_exceeds_balance` | escalated |
| `locked_account` | escalated |
| `stale_policy` | escalated |
| `currency_mismatch` | escalated |

---

## Limitations

- The autopilot (`src/eval/autopilot.ts`) is deterministic, rule-based scaffolding standing in
  for a live model in tests/eval — it validates that the *system* (loop, hooks, validation,
  mocks) behaves correctly, not that a live Claude model would choose the same tool sequence.
  `--live` CLI mode exercises the real model against the same stack.
- Mock backends are in-memory and single-process; there is no persistence across process
  restarts (session/case state included) beyond the JSONL trace logs.
- `SessionManager` is in-memory; a production version would need durable storage for
  session/fork records.
- The four subagents' tool boundaries are enforced in code (`subagentLoop.ts`'s `allowedSet`),
  but their *reasoning* quality in live mode depends on the model — the boundary is a hard floor,
  not a substitute for a good prompt.
- `npm audit` reports vulnerabilities in `vitest`'s transitive dev-only `esbuild`/`vite`
  dependency (dev-server-only, not exploitable in this project's usage); left as-is rather than
  forcing a breaking vitest major-version bump.
- The `RATE_LIMIT` error category is declared and would be retried identically to
  `DEPENDENCY`/`TRANSIENT` (`toolExecutor.ts` treats all three the same way), but no mock backend
  path currently emits it — only `DEPENDENCY` (the flaky-gateway simulation) is exercised.
- `SessionManager`'s resume path is demonstrated end-to-end in `test/session.test.ts` (same
  `CaseContext`, saved transcript replayed into a fresh `AgentLoop`), but is not wired into a CLI
  flag — there is no `--resume <sessionId>` option today.
