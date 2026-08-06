import { describe, it, expect, beforeEach } from "vitest";
import { connectMercuryMcp, type MercuryMcpConnection } from "../src/agent/mcpClient.js";
import { AgentLoop } from "../src/agent/loop.js";
import { CaseContext } from "../src/agent/context.js";
import { FakeClaudeClient, type ClaudeResponse } from "../src/agent/claudeClient.js";
import { _resetPaymentsMockState } from "../src/mock-backends/payments.js";
import { _resetCaseManagementMockState } from "../src/mock-backends/caseManagement.js";
import { getStoredCaseFacts } from "../src/mock-backends/caseManagement.js";

function toolUse(id: string, name: string, input: Record<string, unknown>): ClaudeResponse {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use" };
}

const validFacts = {
  caseId: "case_facts_1",
  customerId: "cust_001",
  identityStatus: "verified" as const,
  issueType: "return" as const,
  region: "US",
  currency: "USD",
  orderId: "ord_1001",
  relevantDates: { orderDate: "2026-07-20", deliveryDate: "2026-07-24", requestDate: "2026-08-05" },
  requestedAmount: { amount: "45.00", currency: "USD" },
  lineItems: [
    {
      sku: "HOME-MUG-01",
      description: "Ceramic travel mug",
      quantity: 1,
      unitPrice: { amount: "45.00", currency: "USD" },
      lineTotal: { amount: "45.00", currency: "USD" },
    },
  ],
  reason: "changed mind",
  knownAmbiguities: [],
};

describe("record_case_facts: structured Case Facts output, end to end", () => {
  let mcp: MercuryMcpConnection;

  beforeEach(async () => {
    _resetPaymentsMockState();
    _resetCaseManagementMockState();
    mcp = await connectMercuryMcp({ readOnlySession: false, traceId: "case-facts-test" });
  });

  it("accepts CaseFacts whose lineItems sum matches requestedAmount, and persists it", async () => {
    const claude = new FakeClaudeClient((callIndex) => {
      if (callIndex === 0) return toolUse("t1", "record_case_facts", validFacts);
      return toolUse("t2", "escalate_to_human", minimalEscalation());
    });
    const ctx = new CaseContext("case_facts_1", "trace_1");
    const loop = new AgentLoop(claude, mcp, "system", ctx);
    await loop.run("help");

    const stored = getStoredCaseFacts("case_facts_1");
    expect(stored?.requestedAmount?.amount).toBe("45.00");
    // No validation-error tool_result was produced for the record_case_facts call.
    expect(ctx.auditTrail[0]?.result.success).toBe(true);
  });

  it("rejects CaseFacts whose lineItems sum does NOT match requestedAmount (line_item_refund_sum == requested_refund_total)", async () => {
    let sawValidationError = false;
    const claude = new FakeClaudeClient((callIndex, request) => {
      if (callIndex === 0) {
        return toolUse("t1", "record_case_facts", {
          ...validFacts,
          requestedAmount: { amount: "120.00", currency: "USD" }, // mismatches the $45 line item
        });
      }
      const last = request.messages[request.messages.length - 1];
      const content = last?.content;
      if (Array.isArray(content)) {
        const block = content.find((b: any) => b.type === "tool_result");
        if (block && (block as any).is_error) sawValidationError = true;
      }
      return toolUse("t2", "escalate_to_human", minimalEscalation());
    });
    const ctx = new CaseContext("case_facts_2", "trace_1");
    const loop = new AgentLoop(claude, mcp, "system", ctx);
    await loop.run("help");

    expect(sawValidationError).toBe(true);
  });
});

function minimalEscalation(): Record<string, unknown> {
  return {
    caseId: "case_facts_1",
    traceId: "trace_1",
    customerSummary: "we'll follow up",
    internalSummary: "needs review",
    identityState: "verified",
    orderFacts: null,
    paymentFacts: null,
    requestedAction: "information_only",
    requestedAmount: null,
    eligibleAmount: null,
    policyDecision: "undetermined",
    policyCitations: [],
    policyVersion: null,
    policyEffectiveDate: null,
    confidence: "low",
    ambiguities: ["test"],
    riskFlags: [],
    actionsAlreadyTaken: [],
    toolFailures: [],
    escalationReason: "test",
    recommendedHumanAction: "review",
    provenance: [],
  };
}
