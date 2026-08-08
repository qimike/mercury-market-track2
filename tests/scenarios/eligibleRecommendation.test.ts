import { describe, expect, it, afterEach } from "vitest";
import { FakeClaudeClient, type ClaudeRequest, type ClaudeResponse, type ClaudeResponseBlock } from "../../src/agent/claudeClient.js";
import { connectMercuryMcp } from "../../src/agent/mcpClient.js";
import { runCoordinator } from "../../src/agent/coordinator.js";
import { COORDINATOR_SYSTEM_PROMPT } from "../../src/agent/prompts/coordinator.js";
import { IDENTITY_SUBAGENT_PROMPT } from "../../src/agent/prompts/identity.js";
import { ORDER_SUBAGENT_PROMPT } from "../../src/agent/prompts/order.js";
import { POLICY_SUBAGENT_PROMPT } from "../../src/agent/prompts/policy.js";
import { RESOLUTION_SUBAGENT_PROMPT } from "../../src/agent/prompts/resolution.js";
import { buildSuggestionPacket, type SuggestionPacketDraft } from "../../src/domain/schemas/suggestionPacket.js";
import { getCurrentSuggestionForCase, _resetPacketStoreMockState } from "../../src/advisor/packetStore.js";
import { _resetPaymentsMockState } from "../../src/mock-backends/payments.js";

afterEach(() => {
  _resetPaymentsMockState();
  _resetPacketStoreMockState();
});

let toolUseSeq = 0;
function toolUse(calls: Array<{ name: string; input: Record<string, unknown> }>): ClaudeResponse {
  const content: ClaudeResponseBlock[] = calls.map((c) => ({ type: "tool_use", id: `tu_${++toolUseSeq}`, name: c.name, input: c.input }));
  return { content, stopReason: "tool_use" };
}
function textEnd(): ClaudeResponse {
  return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
}

describe("Scenario: eligible recommendation remains unexecuted (spec Example A)", () => {
  it("runs the full advisor loop to submit_suggestion_packet without ever touching process_refund/create_return", async () => {
    const packetDraft: SuggestionPacketDraft = {
      caseId: "case_1",
      sessionId: "sess_1",
      customerIntent: "Refund a damaged mug",
      caseSummary: "Order ord_1001 damaged in transit",
      identityStatus: "verified",
      issues: [
        {
          issueId: "issue_1",
          issueType: "damaged_item",
          analysisSummary: "Item arrived damaged; policy eligible at high confidence.",
          decision: "eligible",
          confidence: 0.92,
          customerClaimReferences: [],
          verifiedFactReferences: ["order_lookup"],
          policyCitationReferences: ["POL-RETURN-GLOBAL"],
          missingInformation: [],
          risks: [],
        },
      ],
      integratedRecommendation: {
        recommendedOutcome: "Approve the refund.",
        customerFacingDraft: "We recommend a refund pending human approval.",
        internalSummary: "Eligible per POL-RETURN-GLOBAL.",
        conflictsDetected: [],
        unresolvedQuestions: [],
      },
      proposedActions: [
        {
          actionId: "action_1",
          actionType: "propose_refund",
          description: "Refund $45.00",
          parameters: { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD" },
          executionStatus: "awaiting_approval",
          preconditions: ["Verified customer"],
          blockingIssues: [],
          idempotencyKey: null,
        },
      ],
      policyCitations: [{ policyId: "POL-RETURN-GLOBAL", title: "Global return policy", version: "3", effectiveFrom: "2026-01-01", effectiveTo: null, sourceReference: "policies/global-standard-return.md", relevantClauses: ["30 day window"], retrievedAt: "2026-08-07T00:00:00.000Z" }],
      dataProvenance: [{ sourceType: "policy", sourceReference: "POL-RETURN-GLOBAL", retrievedAt: "2026-08-07T00:00:00.000Z", toolCallId: null, correlationId: null }],
      review: { status: "pass", blockingFindings: [], nonBlockingFindings: [], reviewedAt: "2026-08-07T00:00:00.000Z" },
      overallConfidence: 0.92,
    };
    const finalPacket = buildSuggestionPacket(packetDraft);

    const counters = new Map<string, number>();
    const claude = new FakeClaudeClient((_index: number, request: ClaudeRequest) => {
      const n = counters.get(request.system) ?? 0;
      counters.set(request.system, n + 1);

      if (request.system === COORDINATOR_SYSTEM_PROMPT) {
        if (n === 0) return toolUse([{ name: "delegate_to_identity_subagent", input: { customerId: "cust_001", verificationValue: "94107" } }]);
        if (n === 1)
          return toolUse([
            { name: "delegate_to_order_subagent", input: { orderId: "ord_1001", customerId: "cust_001" } },
            { name: "delegate_to_policy_subagent", input: { region: "US", sku: "HOME-MUG-01", issueType: "return", deliveryDate: "2026-07-24", asOfDate: "2026-08-07" } },
          ]);
        if (n === 2)
          return toolUse([
            { name: "delegate_to_resolution_subagent", input: { issueId: "issue_1", orderId: "ord_1001", customerId: "cust_001", requestedAmount: "45.00", currency: "USD", policyDecision: "eligible", policyConfidence: "high", reason: "damaged item" } },
          ]);
        if (n === 3) return toolUse([{ name: "submit_suggestion_packet", input: finalPacket as unknown as Record<string, unknown> }]);
        return textEnd();
      }
      if (request.system === IDENTITY_SUBAGENT_PROMPT) {
        if (n === 0) return toolUse([{ name: "get_customer", input: { customerId: "cust_001" } }]);
        if (n === 1) return toolUse([{ name: "verify_customer_identity", input: { customerId: "cust_001", verificationValue: "94107" } }]);
        return toolUse([{ name: "submit_identity_finding", input: { caseId: "case_1", customerId: "cust_001", identityStatus: "verified", verified: true, notes: "verified via zip" } }]);
      }
      if (request.system === ORDER_SUBAGENT_PROMPT) {
        if (n === 0) return toolUse([{ name: "lookup_order", input: { orderId: "ord_1001", requestingCustomerId: "cust_001" } }]);
        if (n === 1) return toolUse([{ name: "get_payment_history", input: { orderId: "ord_1001" } }]);
        return toolUse([{ name: "submit_order_finding", input: { caseId: "case_1", orderId: "ord_1001", orderExists: true, customerMatches: true, status: "delivered", currency: "USD", region: "US", deliveryDate: "2026-07-24", lineItems: [], amountPaid: { amount: "45.00", currency: "USD" }, notes: "ok" } }]);
      }
      if (request.system === POLICY_SUBAGENT_PROMPT) {
        if (n === 0) return toolUse([{ name: "evaluate_policy", input: { region: "US", sku: "HOME-MUG-01", issueType: "return", deliveryDate: "2026-07-24", asOfDate: "2026-08-07" } }]);
        return toolUse([{ name: "submit_policy_finding", input: { caseId: "case_1", decision: "eligible", confidence: "high", citations: [], conflicts: [], ambiguities: [], notes: "eligible" } }]);
      }
      if (request.system === RESOLUTION_SUBAGENT_PROMPT) {
        if (n === 0) return toolUse([{ name: "get_payment_history", input: { orderId: "ord_1001" } }]);
        return toolUse([{ name: "submit_resolution_finding", input: { caseId: "case_1", issueId: "issue_1", proposedActionType: "propose_refund", description: "Refund $45", proposedAmount: { amount: "45.00", currency: "USD" }, reason: "eligible", preconditions: [], blockingIssues: [], confidence: "high" } }]);
      }
      throw new Error(`Unscripted system prompt in test: ${request.system.slice(0, 40)}...`);
    });

    const mcp = await connectMercuryMcp({ traceId: "sess_1", readOnlySession: false, callerRole: "advisor_agent" });
    try {
      const result = await runCoordinator({ claude, mcp, caseId: "case_1", traceId: "sess_1", initialUserMessage: "Customer cust_001 wants a refund for a damaged mug on order ord_1001." });

      expect(result.outcome).toBe("resolved");
      expect(result.terminationReason).toBe("submit_suggestion_packet");

      // The core safety guarantee: nowhere in the whole run was process_refund or
      // create_return ever called, attempted, or even offered as a tool.
      const calledToolNames = result.trace.flatMap((t) => t.toolCalls.map((c) => c.name));
      expect(calledToolNames).not.toContain("process_refund");
      expect(calledToolNames).not.toContain("create_return");

      const stored = getCurrentSuggestionForCase("case_1");
      expect(stored?.suggestionId).toBe(finalPacket.suggestionId);
      expect(stored?.proposedActions[0]?.executionStatus).toBe("awaiting_approval"); // never executed
    } finally {
      await mcp.close();
    }
  });
});
