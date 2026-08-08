# Demo guide

All data is synthetic (`src/mock-backends/data.ts`'s seeded customers/orders/
policies). Every command below was run against this repository to confirm
it actually works before being written down.

Run everything from the repo root. `npm run advisor:cli -- <command>` and
`npx tsx src/cli/index.ts <command>` are equivalent; examples use the
shorter `tsx` form. Suggestion packets and approvals persist to
`.mercury-state/` (gitignored) between CLI invocations; delete that
directory to reset the demo.

## 1. Eligible recommendation (no credentials needed)

```bash
npx tsx src/cli/index.ts demo-seed
```

This calls the real `getCustomer`/`verifyCustomerIdentity`/`lookupOrder`/
`getPaymentHistory`/`evaluatePolicy` mock-backend functions for customer
`cust_001` / order `ord_1001` and assembles a real, hash-stamped
`SuggestionPacket` from the actual results — nothing in the packet is
hand-typed or fabricated. It prints the new `suggestionId`; save it for the
next steps.

## 2. Human approval and execution

```bash
SUGG_ID=<paste the suggestionId from step 1>
npx tsx src/cli/index.ts approve "$SUGG_ID" action_1 human_agent_42 "Looks correct"
npx tsx src/cli/index.ts execute "$SUGG_ID" action_1 human_agent_42
```

`execute` opens the one and only `human_support_agent` MCP connection in the
codebase (`src/approvals/execute.ts`), re-checks the remaining refundable
balance against fresh data, and calls `process_refund`. Run `execute` a
second time with the same arguments — it fails with "already executed,"
proving the replay guard.

## 3. Human-edited action

```bash
npx tsx src/cli/index.ts demo-seed              # produces a fresh suggestionId
SUGG_ID=<new suggestionId>
npx tsx src/cli/index.ts approve "$SUGG_ID" action_1 human_agent_42 "ok"
npx tsx src/cli/index.ts edit "$SUGG_ID" action_1 '{"orderId":"ord_1001","customerId":"cust_001","amount":"20.00","currency":"USD"}'
```

The printed packet's `suggestionVersion`/`suggestionHash` and the action's
`actionVersion`/`actionHash` all change, and `humanDecision.status` reverts
to `revision_requested` — the prior approval no longer matches. Attempting
`execute` now fails; re-run `approve` with the new hash, then `execute`
succeeds for the edited ($20.00) amount.

## 4. Duplicate-remedy / cross-issue integration

Not currently reachable via the CLI (it only seeds a single-issue packet).
See `tests/unit/validation.test.ts`'s "detects duplicate compensation" case
for a packet with two proposed refunds against the same order being rejected
deterministically by `validateSuggestionPacket`.

## 5. Temporary upstream failure

See `tests/scenarios/` and the underlying mock (`src/mock-backends/payments.ts`'s
`flakyGateway` table, `ord_1007`/`ord_1008`) — not wired into the CLI in
this phase.

## 6. Ambiguous / conflicting policy

```bash
npx tsx -e "
import('./src/mock-backends/policy.js').then(({evaluatePolicy}) =>
  evaluatePolicy({region:'EU', sku:'ELECTRONICS-DRONE', issueType:'return', deliveryDate:'2026-07-30', asOfDate:'2026-08-02', traceId:'demo'})
    .then(r => console.log(JSON.stringify(r, null, 2))));
"
```

Returns `decision: "undetermined"`, `confidence: "low"`, and a populated
`conflicts` array (a region-wide EU return policy vs. a hazmat-restricted
drone policy) — this is what feeds `escalate_to_human` rather than a
guessed eligibility.

## 7. Session resume / fork

`demo-seed` creates session `sess_demo_001` as a side effect. Session state
is snapshotted to `.mercury-state/sessions.json` (gitignored) the same way
suggestion packets and approvals are, so this works across separate CLI
invocations:

```bash
npx tsx src/cli/index.ts demo-seed                    # creates session sess_demo_001
npx tsx src/cli/index.ts resume sess_demo_001         # separate process — still finds it
npx tsx src/cli/index.ts fork sess_demo_001 "investigate policy conflict"
```

For any other session, create one explicitly first:
`npx tsx src/cli/index.ts session-start <caseId>` (prints the new
`sessionId`). The fork mechanics that matter for safety (read-only
connection, no approval inheritance, scratchpad carry-over rules limited to
`verified`/`resolved` entries) are additionally proven in-process by
`tests/integration/approvals.test.ts`'s "fork cannot execute a side effect
using parent approval" test — the CLI demonstrates the session bookkeeping,
the test suite proves the safety guarantee.

## 8. Advisor direct-execution attempt (blocked)

```bash
npx tsx -e "
import('./src/agent/mcpClient.js').then(async ({connectMercuryMcp}) => {
  const mcp = await connectMercuryMcp({ traceId: 't', readOnlySession: false, callerRole: 'advisor_agent' });
  console.log(JSON.stringify(await mcp.callTool('process_refund', { orderId: 'ord_1001', customerId: 'cust_001', amount: '45.00', currency: 'USD', reason: 'x', idempotencyKey: 'x' }), null, 2));
  await mcp.close();
});
"
```

Fails at the MCP protocol layer — `process_refund` isn't even registered on
an `advisor_agent` connection. See `tests/integration/mcpAuthorization.test.ts`
for the full set of role/hash/fork checks.

## 9. Local CI governance run

```bash
npx tsx src/cli/index.ts governance
```

Runs the deterministic policy/permission/approval-hash checks; adds a
model-assisted pass only if `claude` is on `PATH` (it is not, in the
environment this was built in — see `docs/ci-governance.md`).

## 10. Harmless change that must not create a false-positive blocker

Change a comment or reformat whitespace in `policies/global-standard-return.md`
without touching its front-matter, then rerun `npx tsx src/cli/index.ts
governance` — `checkPolicyCatalog()` only inspects the runtime
`policyCatalog` data (`src/mock-backends/data.ts`), which is unaffected by a
markdown-only comment change, so `status` stays `pass`.
