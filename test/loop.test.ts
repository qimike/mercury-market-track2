import { describe, it, expect, beforeEach } from "vitest";
import { connectMercuryMcp, type MercuryMcpConnection } from "../src/agent/mcpClient.js";
import { AgentLoop } from "../src/agent/loop.js";
import { CaseContext } from "../src/agent/context.js";
import { FakeClaudeClient, type ClaudeResponse } from "../src/agent/claudeClient.js";
import { _resetPaymentsMockState } from "../src/mock-backends/payments.js";
import { _resetCaseManagementMockState } from "../src/mock-backends/caseManagement.js";

function toolUse(id: string, name: string, input: Record<string, unknown>): ClaudeResponse {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use" };
}

describe("AgentLoop (deterministic loop)", () => {
  let mcp: MercuryMcpConnection;

  beforeEach(async () => {
    _resetPaymentsMockState();
    _resetCaseManagementMockState();
    mcp = await connectMercuryMcp({ readOnlySession: false, traceId: "loop-test" });
  });

  it("continues on tool_use, feeds the tool result back, and terminates on a validated resolve_case", async () => {
    const claude = new FakeClaudeClient((callIndex, request) => {
      if (callIndex === 0) return toolUse("t1", "get_customer", { customerId: "cust_001" });
      if (callIndex === 1) return toolUse("t2", "verify_customer_identity", { customerId: "cust_001", verificationValue: "94107" });
      if (callIndex === 2) {
        return toolUse("t3", "resolve_case", {
          caseId: "case_1",
          outcome: "resolved_autonomously",
          customerSummary: "done",
          internalSummary: "done",
          refundTransactionId: null,
          refundAmount: null,
          policyCitations: [],
          actionsTaken: ["verified identity"],
          provenance: [],
        });
      }
      throw new Error(`unexpected call ${callIndex}`);
    });

    const ctx = new CaseContext("case_1", "trace_1");
    const loop = new AgentLoop(claude, mcp, "system prompt", ctx);
    const result = await loop.run("help the customer");

    expect(result.outcome).toBe("resolved");
    expect(result.terminationReason).toBe("resolve_case");
    expect(result.trace).toHaveLength(3);
    expect(result.trace[0]?.toolCalls[0]?.name).toBe("get_customer");
  });

  it("nudges once on a bare end_turn with no terminal tool called, then accepts a subsequent terminal call", async () => {
    let sawNudge = false;
    const claude = new FakeClaudeClient((callIndex, request) => {
      if (callIndex === 0) return { content: [{ type: "text", text: "thinking..." }], stopReason: "end_turn" };
      if (callIndex === 1) {
        const last = request.messages[request.messages.length - 1];
        const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
        sawNudge = text.includes("resolve_case") || text.includes("escalate_to_human");
        return toolUse("t1", "escalate_to_human", buildMinimalEscalation());
      }
      throw new Error(`unexpected call ${callIndex}`);
    });
    const ctx = new CaseContext("case_1", "trace_1");
    const loop = new AgentLoop(claude, mcp, "system prompt", ctx);
    const result = await loop.run("help");
    expect(sawNudge).toBe(true);
    expect(result.outcome).toBe("escalated");
  });

  it("enforces the configured max iteration count and files a fail-safe escalation", async () => {
    const claude = new FakeClaudeClient(() => ({ content: [{ type: "text", text: "still thinking" }], stopReason: "end_turn" }));
    const ctx = new CaseContext("case_maxiter", "trace_1");
    const loop = new AgentLoop(claude, mcp, "system prompt", ctx);
    const result = await loop.run("help");
    expect(result.terminationReason).toBe("max_iterations_exceeded");
    expect(result.outcome).toBe("escalated");
    expect(ctx.escalationStatus).toBe("escalated");
  });

  it("detects a duplicate tool-call loop and escalates instead of looping forever", async () => {
    const claude = new FakeClaudeClient(() => toolUse("dup", "get_customer", { customerId: "cust_001" }));
    const ctx = new CaseContext("case_dup", "trace_1");
    const loop = new AgentLoop(claude, mcp, "system prompt", ctx);
    const result = await loop.run("help");
    expect(result.terminationReason).toBe("duplicate_tool_call_loop");
    expect(result.outcome).toBe("escalated");
  });

  it("runs independent read-only tool_use blocks in parallel within one turn", async () => {
    const claude = new FakeClaudeClient((callIndex) => {
      if (callIndex === 0) {
        return {
          content: [
            { type: "tool_use", id: "a", name: "get_customer", input: { customerId: "cust_001" } },
            { type: "tool_use", id: "b", name: "get_case_history", input: { caseId: "case_1" } },
          ],
          stopReason: "tool_use",
        };
      }
      return toolUse("t3", "escalate_to_human", buildMinimalEscalation());
    });
    const ctx = new CaseContext("case_1", "trace_1");
    const loop = new AgentLoop(claude, mcp, "system prompt", ctx);
    const result = await loop.run("help");
    expect(result.trace[0]?.toolCalls).toHaveLength(2);
    expect(result.outcome).toBe("escalated");
  });

  it("gives a bounded correction retry when resolve_case fails semantic validation, then escalates on exhaustion", async () => {
    let calls = 0;
    const claude = new FakeClaudeClient(() => {
      calls += 1;
      // Always resubmits an unvalidatable resolve_case (fabricated citation) to force exhaustion.
      // internalSummary varies each call so this isn't ALSO flagged as a duplicate-call loop —
      // we want to isolate the output-validation-retry exhaustion path specifically.
      return toolUse(`t${calls}`, "resolve_case", {
        caseId: "case_1",
        outcome: "resolved_autonomously",
        customerSummary: "done",
        internalSummary: `done (attempt ${calls})`,
        refundTransactionId: null,
        refundAmount: null,
        policyCitations: [
          {
            policyId: "POL-FABRICATED",
            version: "1",
            title: "x",
            region: "US",
            skuScope: "ALL",
            effectiveDate: "2026-01-01",
            expirationDate: null,
            excerpt: "x",
            provenance: {
              sourceType: "policy_document",
              sourceId: "x",
              retrievedAt: "2026-08-05T00:00:00.000Z",
              traceId: "t1",
            },
          },
        ],
        actionsTaken: [],
        provenance: [],
      });
    });
    const ctx = new CaseContext("case_1", "trace_1");
    ctx.identityStatus = "verified";
    const loop = new AgentLoop(claude, mcp, "system prompt", ctx);
    const result = await loop.run("help");
    expect(result.terminationReason).toBe("structured_output_retry_exhausted");
    expect(result.outcome).toBe("escalated");
    expect(calls).toBeGreaterThan(1); // at least one correction retry happened
  });
});

function buildMinimalEscalation(): Record<string, unknown> {
  return {
    caseId: "case_1",
    traceId: "trace_1",
    customerSummary: "we'll follow up",
    internalSummary: "needs human review",
    identityState: "unverified",
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
    escalationReason: "test escalation",
    recommendedHumanAction: "review",
    provenance: [],
  };
}
