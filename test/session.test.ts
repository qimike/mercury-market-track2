import { describe, it, expect } from "vitest";
import { SessionManager, investigatePolicyFork, mergePolicyFindingIntoParent } from "../src/agent/session.js";
import { CaseContext } from "../src/agent/context.js";
import { AgentLoop } from "../src/agent/loop.js";
import { connectMercuryMcp } from "../src/agent/mcpClient.js";
import { FakeClaudeClient, type ClaudeResponse } from "../src/agent/claudeClient.js";

function toolUse(id: string, name: string, input: Record<string, unknown>): ClaudeResponse {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use" };
}

describe("session and fork management", () => {
  it("creates a main session and can resume it with its saved transcript", () => {
    const sessions = new SessionManager();
    const main = sessions.createSession("case_1");
    expect(main.kind).toBe("main");
    expect(main.parentSessionId).toBeNull();

    sessions.saveTranscript(main.sessionId, [{ role: "user", content: "hello" }], "active");
    const resumed = sessions.resumeSession(main.sessionId);
    expect(resumed.transcript).toEqual([{ role: "user", content: "hello" }]);
  });

  it("forks a session with a parent/child relationship, sharing caseId and traceId", () => {
    const sessions = new SessionManager();
    const main = sessions.createSession("case_1", "trace_1");
    const fork = sessions.forkSession(main.sessionId, "policy investigation");

    expect(fork.kind).toBe("fork");
    expect(fork.parentSessionId).toBe(main.sessionId);
    expect(fork.caseId).toBe("case_1");
    expect(fork.traceId).toBe("trace_1");
    expect(sessions.listChildren(main.sessionId)).toHaveLength(1);
  });

  it("throws when forking or resuming an unknown session id", () => {
    const sessions = new SessionManager();
    expect(() => sessions.forkSession("nope", "x")).toThrow();
    expect(() => sessions.resumeSession("nope")).toThrow();
  });

  it("investigatePolicyFork detects a real conflict read-only and returns a structured finding", async () => {
    const sessions = new SessionManager();
    const main = sessions.createSession("case_1");
    const finding = await investigatePolicyFork(sessions, main.sessionId, "EU", [
      { sku: "ELECTRONICS-DRONE", asOfDate: "2026-08-05", deliveryDate: "2026-07-30" },
    ]);
    expect(finding.conflictsFound).toBe(true);
    expect(finding.citations.some((c) => c.policyId === "POL-DRONE-HAZMAT")).toBe(true);
    expect(sessions.listChildren(main.sessionId)[0]?.status).toBe("completed");
  });

  it("mergePolicyFindingIntoParent is the only way a fork's citations reach the parent context", async () => {
    const sessions = new SessionManager();
    const main = sessions.createSession("case_1");
    const parentCtx = new CaseContext("case_1", "trace_1");
    expect(parentCtx.seenPolicyCitations.size).toBe(0);

    const finding = await investigatePolicyFork(sessions, main.sessionId, "US", [
      { sku: "HOME-MUG-01", asOfDate: "2026-08-05", deliveryDate: "2026-07-24" },
    ]);
    // Not merged yet — parent context is untouched by the fork running.
    expect(parentCtx.seenPolicyCitations.size).toBe(0);

    mergePolicyFindingIntoParent(finding, parentCtx);
    expect(parentCtx.seenPolicyCitations.size).toBeGreaterThan(0);
  });

  it("resumes a saved session transcript into a new AgentLoop and continues reasoning from it", async () => {
    const mcp = await connectMercuryMcp({ readOnlySession: false, traceId: "resume-test" });
    const sessions = new SessionManager();
    const main = sessions.createSession("case_resume", "trace_resume");
    const ctx = new CaseContext("case_resume", "trace_resume");

    // Turn 1: customer isn't verified yet; the case is escalated pending verification.
    const claude1 = new FakeClaudeClient([
      toolUse("t1", "get_customer", { customerId: "cust_001" }),
      toolUse("t2", "escalate_to_human", {
        caseId: "case_resume",
        traceId: "trace_resume",
        customerSummary: "We need to verify your identity before continuing.",
        internalSummary: "Customer not yet verified; will resume once they respond.",
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
        ambiguities: ["awaiting verification"],
        riskFlags: [],
        actionsAlreadyTaken: [],
        toolFailures: [],
        escalationReason: "Awaiting customer identity verification.",
        recommendedHumanAction: "None yet — resume once the customer verifies.",
        provenance: [],
      }),
    ]);
    const loop1 = new AgentLoop(claude1, mcp, "system prompt", ctx);
    const result1 = await loop1.run("Customer cust_001 wants a refund.");
    sessions.saveTranscript(main.sessionId, result1.transcript, "active");
    expect(result1.outcome).toBe("escalated");

    // Turn 2 (resume): same case/context, a NEW AgentLoop instance, seeded with the
    // saved transcript — the customer has now come back with their verification code.
    const resumedSession = sessions.resumeSession(main.sessionId);
    const claude2 = new FakeClaudeClient([
      toolUse("t3", "verify_customer_identity", { customerId: "cust_001", verificationValue: "94107" }),
      toolUse("t4", "resolve_case", {
        caseId: "case_resume",
        outcome: "resolved_autonomously",
        customerSummary: "Verified — thanks!",
        internalSummary: "Customer verified on resume; no refund requested, information only.",
        refundTransactionId: null,
        refundAmount: null,
        policyCitations: [],
        actionsTaken: ["Verified identity on resumed session"],
        provenance: [],
      }),
    ]);
    const loop2 = new AgentLoop(claude2, mcp, "system prompt", ctx);
    const result2 = await loop2.run(
      "The customer has returned and provided their verification code: 94107.",
      resumedSession.transcript
    );

    // The resumed transcript's prefix is exactly turn 1's full conversation.
    expect(result2.transcript.slice(0, resumedSession.transcript.length)).toEqual(resumedSession.transcript);
    expect(result2.outcome).toBe("resolved");
    expect(ctx.identityStatus).toBe("verified");

    await mcp.close();
  });
});
