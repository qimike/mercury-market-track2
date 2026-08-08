# MCP conventions (src/mcp/)

Path-scoped addition to the root `CLAUDE.md`. Applies to `toolDefinitions.ts`,
`resourceDefinitions.ts`, `server.ts`, and `authorization.ts`.

## The role boundary (read this first)

`server.ts` only registers a tool for a connection if
`isToolAllowedForRole(spec.name, options.callerRole)` (`src/domain/roles.ts`)
— an `advisor_agent` connection's `listTools()` never includes
`process_refund`/`create_return` at all. `authorization.ts` is the second,
independent gate for the two tools that ever reach it on a
`human_support_agent` connection: it requires an on-file, hash-matched,
non-forked, not-yet-executed approval record. Neither check may be satisfied
by anything in a tool's input — `callerRole` is fixed per connection, never
read from `args`.

## Adding a tool

1. Add a `ToolSpec` entry to `toolSpecs` in `toolDefinitions.ts`: `name`,
   `title`, `description` (what it does), `boundaries` (what it explicitly
   will NOT do), `sideEffecting`, `inputShape`/`outputShape` (zod raw
   shapes — use `toolResultShape()` for the output so `success`/`error` stay
   consistent), and at least one usage `example`.
2. Decide the tool's role scope: is it advisor-callable (add its name to
   `ADVISOR_ALLOWED_TOOLS` in `src/domain/roles.ts`) or customer-affecting
   enough that it must be human-execution-only (add it to
   `HUMAN_EXECUTION_ONLY_TOOLS` instead, and gate its handler with
   `authorizeExecution()` from `authorization.ts`)? A tool cannot be in both.
3. **Output shape must be exact.** The MCP SDK validates `structuredContent`
   against `outputSchema` with `additionalProperties: false` once a client
   has cached tool definitions via `listTools()` — a handler that returns
   even one field not declared in `outputShape` fails at the protocol layer
   with an opaque `-32602` error, not a clean `ToolResult` failure. If the
   backing mock-backend function returns a richer object than the tool
   should expose, trim it in the handler (see `escalate_to_human`'s handler
   for the pattern) rather than widening the schema to match, unless the
   extra fields are genuinely part of the tool's contract.
4. If the tool is human-execution-only, decide what `revalidate.ts` needs to
   re-check immediately before it runs (spec: rerun authorization, policy,
   arithmetic, threshold, currency, ownership, and idempotency validation
   against FRESH data, never the suggestion packet's cached numbers).
5. Write the mock backend function in `src/mock-backends/` first — it should
   return `ToolResult<T>`, not throw. The tool handler should be a thin
   adapter, not where business logic lives.
6. Add tests in `tests/integration/mcpAuthorization.test.ts` (if it touches
   the role/authorization boundary) or a new focused test file, covering:
   success, at least one structured failure, and — if relevant — the
   empty-result-is-not-an-error case.

## Adding a resource

Resources are read-only reference documents, not parameterized actions. If
what you're adding needs an input parameter to be useful, it's a tool, not a
resource. Treat any resource whose content could plausibly be user-editable
(the common-Q&A entries, for instance) as untrusted data — say so explicitly
in its `description`, and never let its content path into a permission,
threshold, or role decision anywhere in the codebase.

## Never

- Never add a tool whose surface is broader than one action (no generic
  "run a query" / "call any URL" tools).
- Never let a read tool mutate mock-backend state, even "just for caching."
- Never skip `boundaries` or `examples`.
- Never add a way to set `callerRole` from tool input, a header, or anything
  else the model or a customer message could influence. It is set exactly
  once, by trusted server code, at connection creation.
- Never let `process_refund`/`create_return` be callable without both the
  role check AND the approval-hash check passing.
