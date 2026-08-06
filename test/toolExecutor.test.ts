import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { connectMercuryMcp, type MercuryMcpConnection } from "../src/agent/mcpClient.js";
import { executeTool } from "../src/agent/toolExecutor.js";
import { _resetPaymentsMockState } from "../src/mock-backends/payments.js";

describe("tool executor: hooks -> MCP -> bounded retry", () => {
  let conn: MercuryMcpConnection;

  beforeEach(async () => {
    _resetPaymentsMockState();
    conn = await connectMercuryMcp({ readOnlySession: false });
  });

  afterEach(async () => {
    await conn.close();
  });

  it("short-circuits at the hook layer without calling the tool when identity is unverified", async () => {
    const outcome = await executeTool(conn, "lookup_order", { orderId: "ord_1001", requestingCustomerId: "cust_001" }, {
      caseId: "case_x",
      identityStatus: "unverified",
    });
    expect(outcome.blockedByHook).toBe(true);
    expect(outcome.attempts).toBe(0);
    expect(outcome.result.success).toBe(false);
  });

  it("retries a transient failure and succeeds within the retry budget (ord_1007: fails once)", async () => {
    const outcome = await executeTool(
      conn,
      "process_refund",
      { orderId: "ord_1007", customerId: "cust_007", amount: "60.00", currency: "USD", reason: "x", idempotencyKey: "whatever" },
      { caseId: "case_x", identityStatus: "verified", caseCurrency: "USD", policyDecision: "eligible", policyConfidence: "high" }
    );
    expect(outcome.result.success).toBe(true);
    expect(outcome.attempts).toBe(2);
  });

  it("exhausts the retry budget and returns the final failure (ord_1008: always fails)", async () => {
    const outcome = await executeTool(
      conn,
      "process_refund",
      { orderId: "ord_1008", customerId: "cust_008", amount: "60.00", currency: "USD", reason: "x", idempotencyKey: "whatever" },
      { caseId: "case_x", identityStatus: "verified", caseCurrency: "USD", policyDecision: "eligible", policyConfidence: "high" }
    );
    expect(outcome.result.success).toBe(false);
    expect(outcome.attempts).toBe(3); // 1 initial + 2 retries (config.maxToolRetries default = 2)
  });

  it("never retries a non-retryable error", async () => {
    const outcome = await executeTool(
      conn,
      "lookup_order",
      { orderId: "ord_does_not_exist", requestingCustomerId: "cust_001" },
      { caseId: "case_x", identityStatus: "verified" }
    );
    expect(outcome.result.success).toBe(false);
    expect(outcome.attempts).toBe(1);
  });

  it("blocks process_refund at the hook layer when no eligible/high-confidence policy has been recorded", async () => {
    const outcome = await executeTool(
      conn,
      "process_refund",
      { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "x", idempotencyKey: "x" },
      { caseId: "case_x", identityStatus: "verified", caseCurrency: "USD" }
    );
    expect(outcome.blockedByHook).toBe(true);
    expect(outcome.result.success).toBe(false);
    if (!outcome.result.success) expect(outcome.result.error.errorCode).toBe("POLICY_NOT_ELIGIBLE_FOR_AUTONOMOUS_REFUND");
  });

  it("applies the hook's idempotencyKey override before calling the tool", async () => {
    const outcome = await executeTool(
      conn,
      "process_refund",
      { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "x", idempotencyKey: "ignored" },
      { caseId: "case_abc", identityStatus: "verified", caseCurrency: "USD", policyDecision: "eligible", policyConfidence: "high" }
    );
    expect(outcome.input.idempotencyKey).toBe("case_abc:refund:ord_1001");
  });
});
