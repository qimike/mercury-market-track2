---
name: verbose-log-analysis
description: Analyze large Mercury Market agent execution logs (JSONL trace files) for loops, retry storms, tool failures, validation failures, missing results, and ordering bugs, returning only a compact diagnostic summary.
---

# Verbose log analysis

Use this skill when the user asks to analyze, diagnose, or debug a Mercury Market agent
execution log — typically a `logs/<caseId>.jsonl` file written by `npm run agent:cli` or a
saved evaluation run (see `src/cli.ts`'s `writeTraceLog`). These logs can be very large (one
line per loop iteration, each containing full assistant content and tool call details); do not
read the whole file into the main conversation.

## Log format

Each line is one `TraceEntry` (see `src/agent/loop.ts`):

```json
{
  "iteration": 3,
  "stopReason": "tool_use",
  "assistantContent": [...],
  "toolCalls": [
    { "name": "process_refund", "input": {...}, "success": false, "attempts": 3, "blockedByHook": false }
  ]
}
```

`attempts > 1` means the tool executor retried internally (see `src/agent/toolExecutor.ts`).
`blockedByHook: true` means a programmatic safeguard (`src/agent/hooks.ts`) refused the call
before it ever reached the backend — that is expected, correct behavior, not a bug.

## Procedure

1. **Isolate the work.** Launch a subagent (the `Agent` tool, `subagent_type: "general-purpose"`
   or `Explore`) to read and process the log file. Give it the exact path and this analysis
   checklist. Do not read the raw file yourself into the main conversation — the whole point of
   this skill is to keep a potentially huge log out of the primary context window. Ask the
   subagent to report back ONLY the compact findings below, not excerpts of the raw log.
2. Have the subagent identify, scanning every `toolCalls` entry across all lines:
   - **Repeated tool calls / agent loops** — the same `name` + `input` (structurally equal)
     appearing 2+ times. Note how many times and whether it ultimately succeeded, was blocked by
     `DUPLICATE_TOOL_CALL_LOOP`, or the run ended without resolving it.
   - **Retry storms** — any `attempts > 1`; report the tool name, final `success` value, and
     whether `attempts` reached `config.maxToolRetries` (exhausted) or recovered before that.
   - **Tool failures** — every `success: false`, grouped by `errorCategory`/`errorCode` if present
     in the input/output captured, with counts.
   - **Validation failures** — any `tool_result` content containing "Validation failed" (from
     `formatValidationErrorsForClaude`) or a `resolve_case`/`escalate_to_human` call whose result
     was `success: false`; report which fields failed and how many correction attempts followed.
   - **Missing tool results** — any `tool_use` in `assistantContent` with no corresponding entry
     in that same iteration's `toolCalls` (would indicate a bug in the loop, not normal behavior).
   - **Incorrect ordering / side effects before prerequisites** — any `process_refund` or
     `create_return` call that appears before a successful `verify_customer_identity` /
     `get_customer` (identityStatus verified) earlier in the log, or before a `lookup_order`/
     `evaluate_policy` call for the same order — this would indicate the sequencing rule in
     `AgentLoop.executeToolUseBlocks` (side-effecting tools never batched with reads) was
     bypassed, which should not be possible; flag it as high-severity if found.
   - **Root causes across nested errors** — if any tool result includes a `cause` field
     (`propagate()` in `src/domain/errors.ts`), walk the chain to the innermost cause and report
     that as the actual root cause, not just the outermost message.
3. Return a compact diagnostic summary to the main conversation: a short bullet list per category
   above (only include categories with findings), each bullet citing iteration numbers and tool
   names, plus a one-line overall verdict ("clean run" / "N issues found, most severe: ..."). Do
   not paste raw log content back — summarize it.
