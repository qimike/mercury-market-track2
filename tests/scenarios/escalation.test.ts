import { describe, expect, it, afterEach } from "vitest";
import { FakeClaudeClient, type ClaudeRequest, type ClaudeResponse, type ClaudeResponseBlock } from "../../src/agent/claudeClient.js";
import { connectMercuryMcp } from "../../src/agent/mcpClient.js";
import { runCoordinator } from "../../src/agent/coordinator.js";
import { COORDINATOR_SYSTEM_PROMPT } from "../../src/agent/prompts/coordinator.js";
import { IDENTITY_SUBAGENT_PROMPT } from "../../src/agent/prompts/identity.js";
import { _resetPacketStoreMockState } from "../../src/advisor/packetStore.js";

afterEach(() => _resetPacketStoreMockState());

let seq = 0;
function toolUse(calls: Array<{ name: string; input: Record<string, unknown> }>): ClaudeResponse {
  const content: ClaudeResponseBlock[] = calls.map((c) => ({ type: "tool_use", id: `tu_${++seq}`, name: c.name, input: c.input }));
  return { content, stopReason: "tool_use" };
}

describe("Scenario: locked account escalates immediately, never delegates further", () => {
  it("escalates without attempting order/policy/resolution delegation", async () => {
    const counters = new Map<string, number>();
    const claude = new FakeClaudeClient((_i: number, request: ClaudeRequest) => {
      const n = counters.get(request.system) ?? 0;
      counters.set(request.system, n + 1);

      if (request.system === COORDINATOR_SYSTEM_PROMPT) {
        if (n === 0) return toolUse([{ name: "delegate_to_identity_subagent", input: { customerId: "cust_011", verificationValue: "10005" } }]);
        return toolUse([
          {
            name: "escalate_to_human",
            input: {
              sessionId: "sess_2",
              suggestionId: null,
              caseId: "case_2",
              traceId: "sess_2",
              customerSummary: "We could not verify your account and have escalated to a specialist.",
              internalSummary: "Account cust_011 is locked pending fraud review.",
              identityState: "locked",
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
              ambiguities: ["Identity locked; cannot proceed."],
              riskFlags: ["account_locked"],
              actionsAlreadyTaken: [],
              toolFailures: [],
              escalationReason: "Customer account is locked pending fraud review.",
              recommendedHumanAction: "Manual fraud review required before any further action.",
              provenance: [],
            },
          },
        ]);
      }
      if (request.system === IDENTITY_SUBAGENT_PROMPT) {
        if (n === 0) return toolUse([{ name: "get_customer", input: { customerId: "cust_011" } }]);
        return toolUse([{ name: "submit_identity_finding", input: { caseId: "case_2", customerId: "cust_011", identityStatus: "locked", verified: false, notes: "Account locked pending fraud review; verification not attempted." } }]);
      }
      throw new Error(`Unscripted system prompt: ${request.system.slice(0, 40)}`);
    });

    const mcp = await connectMercuryMcp({ traceId: "sess_2", readOnlySession: false, callerRole: "advisor_agent" });
    try {
      const result = await runCoordinator({ claude, mcp, caseId: "case_2", traceId: "sess_2", initialUserMessage: "Customer cust_011 wants a refund." });
      expect(result.outcome).toBe("escalated");
      expect(result.terminationReason).toBe("escalate_to_human");

      const calledToolNames = result.trace.flatMap((t) => t.toolCalls.map((c) => c.name));
      expect(calledToolNames).not.toContain("delegate_to_order_subagent");
      expect(calledToolNames).not.toContain("delegate_to_resolution_subagent");
      expect(calledToolNames).not.toContain("process_refund");
    } finally {
      await mcp.close();
    }
  });
});
