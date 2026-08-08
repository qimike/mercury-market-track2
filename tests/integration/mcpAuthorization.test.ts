import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { connectMercuryMcp, type MercuryMcpConnection } from "../../src/agent/mcpClient.js";
import { verifyCustomerIdentity } from "../../src/mock-backends/identity.js";
import { _resetPaymentsMockState } from "../../src/mock-backends/payments.js";
import { _resetReturnsMockState } from "../../src/mock-backends/returns.js";
import { recordApproval, _resetApprovalStoreMockState, type ApprovalRecord } from "../../src/approvals/store.js";

const openConnections: MercuryMcpConnection[] = [];
async function open(opts: Parameters<typeof connectMercuryMcp>[0]): Promise<MercuryMcpConnection> {
  const conn = await connectMercuryMcp(opts);
  openConnections.push(conn);
  return conn;
}

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map((c) => c.close()));
  _resetPaymentsMockState();
  _resetReturnsMockState();
  _resetApprovalStoreMockState();
});

function baseApproval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    suggestionId: "sugg_1",
    suggestionVersion: 1,
    suggestionHash: "a".repeat(64),
    actionId: "action_1",
    actionVersion: 1,
    actionHash: "b".repeat(64),
    status: "approved",
    reviewerReference: "human_1",
    decidedAt: "2026-08-07T00:00:00.000Z",
    forkedFromSessionId: null,
    executedAt: null,
    executedTransactionRef: null,
    ...overrides,
  };
}

const executionContext = {
  humanActorId: "human_1",
  suggestionId: "sugg_1",
  suggestionVersion: 1,
  suggestionHash: "a".repeat(64),
  actionId: "action_1",
  actionVersion: 1,
  actionHash: "b".repeat(64),
};

describe("MCP authorization boundary", () => {
  beforeEach(async () => {
    await verifyCustomerIdentity("cust_001", "94107");
  });

  it("does not even list process_refund/create_return for an advisor_agent connection", async () => {
    const mcp = await open({ traceId: "t1", readOnlySession: false, callerRole: "advisor_agent" });
    const tools = await mcp.listToolDefinitions();
    expect(tools.some((t) => t.name === "process_refund")).toBe(false);
    expect(tools.some((t) => t.name === "create_return")).toBe(false);
  });

  it("refuses process_refund from an advisor_agent connection even with a fully-formed request", async () => {
    // process_refund isn't even registered on an advisor_agent connection (see the
    // preceding test), so the MCP protocol itself rejects the unknown tool name —
    // an even stronger guarantee than a handler-level check that could in
    // principle be reached. This proves there is no way to get from here to the
    // authorization.ts code path at all on this connection.
    const mcp = await open({ traceId: "t2", readOnlySession: false, callerRole: "advisor_agent" });
    const result = await mcp.callTool("process_refund", {
      orderId: "ord_1001",
      customerId: "cust_001",
      amount: "45.00",
      currency: "USD",
      reason: "trying anyway",
      idempotencyKey: "whatever",
      executionContext,
    });
    expect(result.success).toBe(false);
  });

  it("refuses process_refund from a human_support_agent connection with no executionContext", async () => {
    const mcp = await open({ traceId: "t3", readOnlySession: false, callerRole: "human_support_agent" });
    const result = await mcp.callTool("process_refund", { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "x", idempotencyKey: "k1" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("MISSING_EXECUTION_CONTEXT");
  });

  it("refuses process_refund when no approval record exists for the suggestion/action", async () => {
    const mcp = await open({ traceId: "t4", readOnlySession: false, callerRole: "human_support_agent" });
    const result = await mcp.callTool("process_refund", { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "x", idempotencyKey: "k1", executionContext });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("APPROVAL_NOT_FOUND");
  });

  it("refuses process_refund when the suggestionHash does not match the approval record", async () => {
    recordApproval(baseApproval());
    const mcp = await open({ traceId: "t5", readOnlySession: false, callerRole: "human_support_agent" });
    const result = await mcp.callTool("process_refund", {
      orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "x", idempotencyKey: "k1",
      executionContext: { ...executionContext, suggestionHash: "c".repeat(64) },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("SUGGESTION_HASH_MISMATCH");
  });

  it("refuses process_refund when the actionHash does not match (edited-after-approval case)", async () => {
    recordApproval(baseApproval());
    const mcp = await open({ traceId: "t6", readOnlySession: false, callerRole: "human_support_agent" });
    const result = await mcp.callTool("process_refund", {
      orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "x", idempotencyKey: "k1",
      executionContext: { ...executionContext, actionHash: "d".repeat(64) },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("ACTION_HASH_MISMATCH");
  });

  it("refuses process_refund for an approval recorded from a forked session", async () => {
    recordApproval(baseApproval({ forkedFromSessionId: "parent_sess_1" }));
    const mcp = await open({ traceId: "t7", readOnlySession: false, callerRole: "human_support_agent" });
    const result = await mcp.callTool("process_refund", { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "x", idempotencyKey: "k1", executionContext });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("FORKED_APPROVAL_NOT_EXECUTABLE");
  });

  it("refuses process_refund in a read-only (forked) session even for human_support_agent with a valid approval", async () => {
    recordApproval(baseApproval());
    const mcp = await open({ traceId: "t8", readOnlySession: true, callerRole: "human_support_agent" });
    const result = await mcp.callTool("process_refund", { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "x", idempotencyKey: "k1", executionContext });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("SIDE_EFFECT_IN_READ_ONLY_SESSION");
  });

  it("allows process_refund for human_support_agent with a valid, matching, non-forked approval", async () => {
    recordApproval(baseApproval());
    const mcp = await open({ traceId: "t9", readOnlySession: false, callerRole: "human_support_agent" });
    const result = await mcp.callTool("process_refund", { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "eligible return", idempotencyKey: "k1", executionContext });
    expect(result.success).toBe(true);
  });

  it("refuses a second execution of an already-executed approval (replay guard)", async () => {
    recordApproval(baseApproval());
    const mcp = await open({ traceId: "t10", readOnlySession: false, callerRole: "human_support_agent" });
    const first = await mcp.callTool("process_refund", { orderId: "ord_1001", customerId: "cust_001", amount: "10.00", currency: "USD", reason: "x", idempotencyKey: "k1", executionContext });
    expect(first.success).toBe(true);
    // Mark executed the way execute.ts would (authorization.ts only checks the approval store, not the payments idempotency store).
    const { markExecuted } = await import("../../src/approvals/store.js");
    markExecuted("sugg_1", "action_1", "txn_x", new Date().toISOString());
    const second = await mcp.callTool("process_refund", { orderId: "ord_1001", customerId: "cust_001", amount: "10.00", currency: "USD", reason: "x", idempotencyKey: "k1", executionContext });
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error.errorCode).toBe("APPROVAL_ALREADY_EXECUTED");
  });
});
