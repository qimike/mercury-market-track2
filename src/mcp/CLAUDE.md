# MCP conventions (src/mcp/)

Path-scoped addition to the root `CLAUDE.md`. Applies to `toolDefinitions.ts`,
`resourceDefinitions.ts`, and `server.ts`.

## Adding a tool

1. Add a `ToolSpec` entry to `toolSpecs` in `toolDefinitions.ts`: `name`,
   `title`, `description` (what it does), `boundaries` (what it explicitly
   will NOT do), `sideEffecting`, `inputShape`/`outputShape` (zod raw
   shapes — use `toolResultShape()` for the output so `success`/`error` stay
   consistent), and at least one usage `example`.
2. If the tool is side-effecting, decide whether it needs a `forkGuard()`
   check (should it be refused in a read-only/forked session?) and whether
   it needs a `hooks.ts` entry (does it need identity verification or a
   threshold check before it runs?).
3. Write the mock backend function in `src/mock-backends/` first — it should
   return `ToolResult<T>`, not throw. The tool handler should be a thin
   adapter, not where business logic lives.
4. Add tests in `test/mcpTools.test.ts` (or a new file) covering: success,
   at least one structured failure, and — if relevant — the empty-result-is-
   not-an-error case.

## Adding a resource

Resources are read-only reference documents, not parameterized actions. If
what you're adding needs an input parameter to be useful, it's a tool, not a
resource.

## Never

- Never add a tool whose surface is broader than one action (no generic
  "run a query" / "call any URL" tools).
- Never let a read tool mutate mock-backend state, even "just for caching."
- Never skip `boundaries` or `examples` — they are read by both Claude (via
  the tool description sent to the model) and by engineers reading this
  file, and both audiences need them.
