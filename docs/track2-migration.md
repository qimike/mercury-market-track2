# Track 2 migration assessment

## Baseline

Track 2 is a separate sibling repository cloned from the completed Track 1
baseline. See `docs/track2-baseline.md` for the exact source path, baseline
commit, and clone-boundary verification. This document covers what happened
*after* the clone: Track 2 was rebuilt from a thin governance add-on into a
standalone advisor platform.

## Component-by-component

| Component | Decision | Reason | Affected files |
|---|---|---|---|
| `Money`, `ToolError`/`ToolResult` | Reuse unchanged | Decimal-safe arithmetic and the structured-error model are autonomy-agnostic. | `src/domain/money.ts`, `src/domain/errors.ts` |
| Zod primitive schemas (`MoneySchema`, `ProvenanceSchema`, `PolicyCitationSchema`, `LineItemSchema`) | Reuse unchanged | Same reasoning. | `src/domain/schemas.ts` |
| `CaseFactsSchema`, `ResolutionSchema`, `RefundDecisionSchema`, `RefundFindingSchema` | Removed | Encoded "resolved_autonomously"/an already-executed refund — the exact autonomous semantics Track 2 forbids. | `src/domain/schemas.ts` (removed); replaced by `src/domain/schemas/advisorCaseFacts.ts`, `src/domain/schemas/proposalFinding.ts` |
| New: role/permission model | New | Nothing in Track 1 modeled "which connection may call which tool." | `src/domain/roles.ts` |
| New: SuggestionPacket/Rationale/CiReview schemas | New | Track 1 had no propose-then-approve artifact at all. | `src/domain/schemas/{suggestionPacket,rationale,ciReview,canonicalJson}.ts` |
| Mock backends: CRM/Identity/OMS/Payments/Policy | Reuse unchanged | Deterministic, autonomy-agnostic; idempotency/balance/currency checks are exactly what Track 2 still needs. | `src/mock-backends/{crm,identity,oms,payments,policy}.ts` |
| `caseManagement.ts` | Extended | Kept case-event log + case-facts storage; removed `escalateToHuman`/`recordResolution`/`getResolution` (autonomous-specific), moved escalation storage to a typed queue. | `src/mock-backends/caseManagement.ts` |
| `returns.ts` | Reuse unchanged | Return-authorization logic itself doesn't care who's allowed to call it — that's enforced one layer up. | `src/mock-backends/returns.ts` |
| Ticketing, approval queue adapters | New | Required by spec §6/§11; didn't exist in Track 1 at all. | `src/mock-backends/{ticketing,approvalQueue}.ts` |
| MCP tool definitions | Rewritten | `process_refund`/`create_return` needed the `executionContext` + role-gate; `resolve_case` removed; `submit_suggestion_packet`/`submit_resolution_finding` added; `escalate_to_human` retargeted at the typed queue. | `src/mcp/toolDefinitions.ts` |
| MCP server tool registration | Extended | Added role-scoped registration (`isToolAllowedForRole`) so a disallowed tool isn't even listed. | `src/mcp/server.ts` |
| MCP resources | Extended | Fixed stale threshold names; added permission-summary, review-criteria, reason-code-catalog, common-Q&A resources. | `src/mcp/resourceDefinitions.ts` |
| New: server-side authorization gate | New | Track 1 had no server-side execution boundary at all — only a client-side hook that *permitted* autonomous refunds. | `src/mcp/authorization.ts` |
| `hooks.ts` | Repurposed | From "identity + refund-threshold + idempotency enforcement that allows autonomous execution" to "advisor-side fail-fast pre-check that unconditionally forbids the two execution tools." | `src/agent/hooks.ts` |
| `context.ts` | Extended | Removed `resolutionOutcome`/refund-execution ingestion cases; added `suggestionId` tracking. | `src/agent/context.ts` |
| `validation.ts` | Rewritten | `validateResolution` → `validateSuggestionPacket` (new checks: zero-citation "unsupported certainty," duplicate-order detection, review-status gate); `validateCaseFacts` → `validateAdvisorCaseFacts`. | `src/agent/validation.ts` |
| `loop.ts` | Extended | Terminal-tool set is now `{submit_suggestion_packet, escalate_to_human}` — no `resolve_case`. | `src/agent/loop.ts` |
| `mcpClient.ts` | Extended | `connectMercuryMcp` takes a `callerRole` (default `advisor_agent`). | `src/agent/mcpClient.ts` |
| `coordinator.ts`, subagents (identity/order/policy) | Reuse unchanged in shape | Same delegation pattern; `refund.ts` subagent replaced. | `src/agent/coordinator.ts`, `src/agent/subagents/{identity,order,policy}.ts` |
| `refund.ts` subagent | Replaced | Could call `create_return`/`process_refund` directly. | Removed; replaced by `src/agent/subagents/resolution.ts` (read-only, proposal-only) |
| `session.ts` | Reuse unchanged | Fork-gets-read-only-connection pattern already matched what Track 2 needs everywhere, not just for forks. | `src/agent/session.ts` |
| `src/eval/` (autopilot + 13 scenarios) | Removed | Built entirely around autonomous-resolution outcomes (`resolved`/`escalated` meaning "refund executed"). | Removed; replaced by `tests/scenarios/*.test.ts` using the same `FakeClaudeClient` pattern, retargeted at suggestion-packet outcomes |
| `src/feedback/` | Removed | Retrospective agent-vs-human comparison assumes autonomous decisions exist to compare against — Track 2 has none. | Removed, no replacement |
| Root `src/cli.ts` | Removed | Ran the full autonomous agent end-to-end. | Removed; replaced by `src/cli/index.ts` |
| `src/track2/{governance,cli}.ts` (prior thin layer) | Replaced | Ad hoc, non-schema-validated approval gate; superseded by the full `src/approvals/` + `src/domain/schemas/suggestionPacket.ts` implementation. | Removed |
| New: `src/advisor/` | New | Advisor-facing entry point, derived rationale, packet version store. | `src/advisor/{orchestrator,rationale,packetStore}.ts` |
| New: `src/approvals/` | New | The entire human-decision + execution-authorization workflow didn't exist in Track 1. | `src/approvals/{store,decide,revalidate,execute,riskGate}.ts` |
| New: `src/sessions/`, `src/audit/` | New | Typed scratchpad and cross-source audit-timeline aggregation didn't exist. | `src/sessions/{index,scratchpad}.ts`, `src/audit/auditLog.ts` |
| New: `src/governance/` | New | Deterministic + model-assisted CI checks didn't exist. | `src/governance/{deterministicChecks,ciReview}.ts` |
| New: `src/cli/` | New | Demo CLI covering the full propose → approve → execute → audit → governance flow. | `src/cli/{index,persistence}.ts` |

## Test coverage tied to migration

78 tests across 16 files under `tests/{unit,integration,scenarios,governance,
security}/`. This covers the architecturally load-bearing subset of the
spec's 46 named scenario tests — role/hash/fork authorization (10 tests),
approval lifecycle including material-edit invalidation and replay
(9 tests), full end-to-end advisor-loop runs for an eligible recommendation
and a locked-account escalation (2 tests), deterministic governance checks
and prior-finding comparison (8 tests), prompt-injection resistance
(3 tests), plus unit coverage for money/errors/roles/schemas/validation
(remainder).

**Explicitly deferred** (not yet implemented as tests, tracked here rather
than silently dropped): retryable-CRM/OMS-failure scenarios beyond what
`tests/unit/payments.test.ts` covers, rate-limit retry-after handling,
persistently-invalid-packet-fails-safely as an end-to-end scenario (the
underlying `handleOutputRetry` bound is exercised only indirectly),
policy-not-yet-effective/expired as dedicated scenario tests (covered
today only via `evaluate_policy`'s own deterministic logic, not a
full advisor-loop run), a dedicated multi-approval-order test (§46 #46),
and the "CI catches an unsafe tool-description change" /
"CI does not block a harmless wording change" pair as literal tests — the
mechanism they'd exercise (the model-assisted CI pass) is not verifiable in
an environment without the `claude` CLI installed; the deterministic side of
governance is fully tested instead.

## Evidence of separation from Track 1

- Track 1 (`/Users/xl/mercury-market`) and Track 2
  (`/Users/xl/mercury-market-track2`) are different absolute paths on
  different git histories after the clone (Track 2 has its own branch,
  `track2-advisor-governance`, and its own remote name, `track1-baseline`,
  to prevent an accidental push back).
- Every file change described above was made exclusively under
  `/Users/xl/mercury-market-track2`. The final verification step in this
  phase re-checks Track 1's working tree, branch, and HEAD commit against
  the baseline record and confirms no drift.
