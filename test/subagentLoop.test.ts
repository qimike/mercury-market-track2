import { describe, it, expect, beforeEach } from "vitest";
import { connectMercuryMcp, type MercuryMcpConnection } from "../src/agent/mcpClient.js";
import { runSubagentLoop } from "../src/agent/subagentLoop.js";
import { CaseContext } from "../src/agent/context.js";
import { FakeClaudeClient, type ClaudeResponse } from "../src/agent/claudeClient.js";

describe("subagent loop boundaries", () => {
  let mcp: MercuryMcpConnection;

  beforeEach(async () => {
    mcp = await connectMercuryMcp({ readOnlySession: false, traceId: "subagent-test" });
  });

  it("refuses a tool call outside the subagent's allowed set", async () => {
    const claude = new FakeClaudeClient((callIndex): ClaudeResponse => {
      if (callIndex === 0) {
        // process_refund is NOT in the identity subagent's allowlist.
        return { content: [{ type: "tool_use", id: "t1", name: "process_refund", input: { orderId: "ord_1001", customerId: "cust_001", amount: "1.00", currency: "USD", reason: "x", idempotencyKey: "x" } }], stopReason: "tool_use" };
      }
      return {
        content: [{ type: "tool_use", id: "t2", name: "submit_identity_finding", input: { caseId: "case_1", customerId: "cust_001", identityStatus: "unverified", verified: false, notes: "blocked" } }],
        stopReason: "tool_use",
      };
    });

    const ctx = new CaseContext("case_1", "trace_1");
    const result = await runSubagentLoop({
      claude,
      mcp,
      context: ctx,
      systemPrompt: "identity subagent",
      allowedMcpTools: ["get_customer", "verify_customer_identity"],
      findingToolName: "submit_identity_finding",
      initialUserMessage: "look up cust_001",
    });

    expect(result.outcome).toBe("submitted");
    expect(result.trace[0]?.toolCalls[0]?.name).toBe("process_refund");
    expect(result.trace[0]?.toolCalls[0]?.blockedByHook).toBe(true);
  });

  it("captures the finding from the designated finding tool", async () => {
    const claude = new FakeClaudeClient((callIndex): ClaudeResponse => {
      if (callIndex === 0) return { content: [{ type: "tool_use", id: "t1", name: "get_customer", input: { customerId: "cust_001" } }], stopReason: "tool_use" };
      return {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "submit_identity_finding",
            input: { caseId: "case_1", customerId: "cust_001", identityStatus: "unverified", verified: false, notes: "not yet verified" },
          },
        ],
        stopReason: "tool_use",
      };
    });

    const ctx = new CaseContext("case_1", "trace_1");
    const result = await runSubagentLoop<{ verified: boolean }>({
      claude,
      mcp,
      context: ctx,
      systemPrompt: "identity subagent",
      allowedMcpTools: ["get_customer", "verify_customer_identity"],
      findingToolName: "submit_identity_finding",
      initialUserMessage: "look up cust_001",
    });

    expect(result.outcome).toBe("submitted");
    expect(result.finding?.verified).toBe(false);
  });
});
