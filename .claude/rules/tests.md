# Test rules

- Tests live under `tests/{unit,integration,scenarios,governance,security}/`
  — unit tests for pure functions and schemas, integration tests for
  MCP/approval wiring, scenarios for full advisor-loop runs via
  `FakeClaudeClient`, governance for CI-check logic, security for
  injection/privilege-escalation resistance.
- `npm test` must pass with zero `ANTHROPIC_API_KEY` set. Every test uses
  `FakeClaudeClient` or calls mock backends/hooks/validators directly. A
  test needing the live API must be gated behind
  `process.env.MERCURY_ENABLE_LIVE_API_TESTS === "1"` and skipped otherwise.
- Never weaken a test (loosen an assertion, remove a case) merely to make it
  pass — fix the underlying code, or if the test's premise was wrong, say so
  explicitly and explain why.
- A new tool, hook, validator, or approval-workflow change needs a test
  covering both the success path and at least one structured-failure path.
- Prefer real assertions over snapshots for anything involving hashes,
  authorization decisions, or financial arithmetic — a snapshot would
  silently "pass" a hash that changed for the wrong reason.
- Mock-backend state must be reset between tests via each module's
  `_reset*MockState()` function (in `afterEach`) — don't rely on test
  ordering for isolation.
