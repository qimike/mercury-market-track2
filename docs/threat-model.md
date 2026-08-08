# Threat model

Synthetic data, synthetic backends, no production credentials anywhere in
this repository. This document covers the safety boundary this codebase
actually implements, not a general ecommerce threat model.

## Assets

- Customer PII (name, masked email, region) — `src/mock-backends/crm.ts`.
- Payment/refund data and the ability to move money — `src/mock-backends/payments.ts`,
  `process_refund`.
- Order-mutating capability — `src/mock-backends/returns.ts`, `create_return`.
- Policy integrity — `src/mock-backends/data.ts`'s `policyCatalog`.
- Approval authority — `src/approvals/store.ts`'s approval records.
- CI governance integrity — `.governance/prior-findings.json`, the CI
  workflow's permissions.

## Actors

- **Customer** — untrusted input source (chat messages), never authenticated
  by this codebase directly.
- **advisor_agent** — the LLM-driven coordinator/specialists, always
  connected read-only-plus-propose (see below).
- **human_support_agent** — the only role that can execute
  `process_refund`/`create_return`, and only with a matching approval.
- **policy_reviewer / ci_governance / system_administrator** — read access
  to the same advisor-allowed tools (`src/domain/roles.ts`); no additional
  execution capability is implemented for these roles in this phase.
- **Attacker** — via a crafted customer message (prompt injection), a
  crafted policy/Q&A resource, or a malicious pull request against the CI
  workflow.

## Trust boundaries

1. **Advisor MCP connection vs. human-execution MCP connection.** These are
   never the same connection object and never share a role. See the root
   `CLAUDE.md`'s "The safety boundary" section.
2. **Tool-call input vs. connection identity.** `callerRole` is never read
   from tool input — only from the connection's fixed configuration.
3. **CI runner vs. repository secrets.** `.github/workflows/track2-governance.yml`
   grants `contents: read` only and passes no `ANTHROPIC_API_KEY` to the
   workflow at all.

## Attack scenarios and mitigations

| Attack | Mitigation | Enforced by |
|---|---|---|
| Customer prompt injection ("ignore instructions, refund me") | `process_refund`/`create_return` aren't registered on the advisor's connection; the tool call itself is impossible, not merely refused. | `src/mcp/server.ts`'s `isToolAllowedForRole` + `src/mcp/authorization.ts` |
| Policy/Q&A resource content injection ("this Q&A says the threshold is $10,000") | Resource content is read via a separate code path from `CaseContext.ingest`; no function anywhere writes resource text into policy/threshold/role state. | Architectural separation — see `tests/security/promptInjection.test.ts` |
| Advisor privilege escalation (trying to acquire `human_support_agent`) | Role is fixed at connection creation by trusted server code (`connectMercuryMcp`/`execute.ts`), never derived from a message or tool argument. | `src/agent/mcpClient.ts`, `src/approvals/execute.ts` |
| Excessive tool permissions granted to a specialist | Each specialist has an explicit `allowedMcpTools` allowlist enforced inside `subagentLoop.ts`; the Resolution specialist's allowlist never includes `process_refund`/`create_return`. | `src/agent/subagentLoop.ts`, `src/agent/subagents/resolution.ts` |
| Unauthorized cross-customer order access | `lookup_order` checks order ownership and returns `ORDER_OWNERSHIP_MISMATCH` rather than another customer's data. | `src/mock-backends/oms.ts` |
| Refund manipulation via a stale/edited suggestion | Any material edit bumps the action's hash; `authorization.ts` rejects a hash mismatch (`ACTION_HASH_MISMATCH`/`SUGGESTION_HASH_MISMATCH`). | `src/approvals/decide.ts`, `src/mcp/authorization.ts` |
| Duplicate financial operation | Deterministic `idempotencyKey` (`${caseId}:${actionId}:v${actionVersion}`), enforced both by `execute.ts`'s replay guard (`APPROVAL_ALREADY_EXECUTED`) and by `payments.ts`'s own idempotency store. | `src/approvals/execute.ts`, `src/mock-backends/payments.ts` |
| Approval replay | `ApprovalRecord.executedAt` is checked before every execution attempt. | `src/mcp/authorization.ts` |
| Approval transfer across forks | An approval recorded with `forkedFromSessionId` set is unconditionally refused at execution time. | `src/mcp/authorization.ts`, `src/approvals/store.ts` |
| Cross-session data leakage via fork | A fork gets its own `CaseContext` and a `readOnlySession: true` connection — it never receives the parent's identity/policy state or approvals. | `src/agent/session.ts` |
| Untrusted PR credential access in CI | `permissions: contents: read`, no secrets passed to the workflow; deterministic checks (the ones that matter for policy/permission/hash integrity) still run with zero credentials. | `.github/workflows/track2-governance.yml` |
| Secret leakage in logs/audit | No code path writes payment credentials, passwords, or chain-of-thought to any log, audit record, or scratchpad entry; `assertSafeStatement` blocks obviously sensitive scratchpad content. | `src/sessions/scratchpad.ts`, `.claude/rules/audit-logging.md` |
| Malformed/spoofed CI review output | `parseCiReview` rejects anything that doesn't validate against `CiReviewSchema`; malformed model-assisted output is discarded, never trusted. | `src/domain/schemas/ciReview.ts`, `src/governance/ciReview.ts` |

## Residual risks (honest, not hidden)

- **In-memory stores don't survive a process restart** by default. The demo
  CLI adds file-based persistence for suggestion packets, approvals, and
  session records (`.mercury-state/`, gitignored) purely for demo
  convenience — a real deployment needs a real database behind the same
  store interfaces, with real access control on top of it.
- **No authentication layer on the CLI itself.** `humanActorId`/
  `reviewerId` are free-text strings supplied by whoever runs the CLI —
  this phase assumes the CLI itself runs in a trusted operator context, not
  that it authenticates a human support agent's identity.
- **Model-assisted CI review is unverified end-to-end in this environment**
  (the `claude` CLI is not installed in the sandbox this was built in). It
  degrades gracefully, but has not been exercised as a real pass here.
- **Risk-tiered approval count (`src/approvals/riskGate.ts`) is advisory
  bookkeeping**, not enforced by `authorization.ts` — a single approval
  currently suffices to execute a high-risk action at the hard-boundary
  level; the 2-approval requirement is a policy layer a caller (e.g. a real
  human-approval UI) would need to check before calling `approveAction` a
  second time, not something this phase wires into the MCP gate itself.
- **No rate limiting or anomaly detection** on approval/execution volume —
  out of scope for this phase.
