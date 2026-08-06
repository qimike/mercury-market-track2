import { describe, it, expect } from "vitest";
import { CaseContext } from "../src/agent/context.js";
import { validateResolution, validateEscalationPacket } from "../src/agent/validation.js";
import type { Resolution, EscalationPacket, PolicyCitation } from "../src/domain/schemas.js";

function fakeCitation(policyId: string, version: string): PolicyCitation {
  return {
    policyId,
    version,
    title: "Test policy",
    region: "US",
    skuScope: "ALL",
    effectiveDate: "2026-01-01",
    expirationDate: null,
    excerpt: "excerpt",
    provenance: {
      sourceType: "policy_document",
      sourceId: "policies/test.md",
      policyId,
      policyVersion: version,
      effectiveDate: "2026-01-01",
      retrievedAt: "2026-08-05T00:00:00.000Z",
      traceId: "t1",
    },
  };
}

function baseResolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    caseId: "case_1",
    outcome: "resolved_autonomously",
    customerSummary: "summary",
    internalSummary: "summary",
    refundTransactionId: null,
    refundAmount: null,
    policyCitations: [],
    actionsTaken: [],
    provenance: [],
    ...overrides,
  };
}

describe("semantic validation", () => {
  it("rejects a resolution citing a policy never retrieved this case", () => {
    const ctx = new CaseContext("case_1", "trace_1");
    ctx.identityStatus = "verified";
    const resolution = baseResolution({ policyCitations: [fakeCitation("POL-FABRICATED", "1")] });
    const result = validateResolution(resolution, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.message.includes("never returned"))).toBe(true);
  });

  it("accepts a resolution citing a policy that was actually retrieved", () => {
    const ctx = new CaseContext("case_1", "trace_1");
    ctx.identityStatus = "verified";
    const citation = fakeCitation("POL-RETURN-GLOBAL", "3");
    ctx.seenPolicyCitations.set(citation.policyId, citation);
    const resolution = baseResolution({ policyCitations: [citation] });
    const result = validateResolution(resolution, ctx);
    expect(result.valid).toBe(true);
  });

  it("rejects a resolution whose identity was never verified", () => {
    const ctx = new CaseContext("case_1", "trace_1");
    const resolution = baseResolution();
    const result = validateResolution(resolution, ctx);
    expect(result.valid).toBe(false);
  });

  it("rejects a resolution claiming a refund amount at/above the mandatory escalation limit", () => {
    const ctx = new CaseContext("case_1", "trace_1");
    ctx.identityStatus = "verified";
    ctx.seenTransactionIds.add("txn_1");
    const resolution = baseResolution({
      refundTransactionId: "txn_1",
      refundAmount: { amount: "999.00", currency: "USD" },
    });
    const result = validateResolution(resolution, ctx);
    expect(result.valid).toBe(false);
  });

  it("rejects a resolution whose transaction id does not match any process_refund result seen this case", () => {
    const ctx = new CaseContext("case_1", "trace_1");
    ctx.identityStatus = "verified";
    const resolution = baseResolution({
      refundTransactionId: "txn_fabricated",
      refundAmount: { amount: "10.00", currency: "USD" },
    });
    const result = validateResolution(resolution, ctx);
    expect(result.valid).toBe(false);
  });

  it("rejects a resolution with an amount but no transaction id, and vice versa", () => {
    const ctx = new CaseContext("case_1", "trace_1");
    ctx.identityStatus = "verified";
    const missingTxn = validateResolution(
      baseResolution({ refundAmount: { amount: "10.00", currency: "USD" } }),
      ctx
    );
    expect(missingTxn.valid).toBe(false);

    ctx.seenTransactionIds.add("txn_1");
    const missingAmount = validateResolution(baseResolution({ refundTransactionId: "txn_1" }), ctx);
    expect(missingAmount.valid).toBe(false);
  });

  it("escalation packets require provenance whenever citations are present", () => {
    const ctx = new CaseContext("case_1", "trace_1");
    const citation = fakeCitation("POL-RETURN-EU", "2");
    ctx.seenPolicyCitations.set(citation.policyId, citation);
    const packet: EscalationPacket = {
      caseId: "case_1",
      traceId: "t1",
      customerSummary: "x",
      internalSummary: "x",
      identityState: "verified",
      orderFacts: null,
      paymentFacts: null,
      requestedAction: "refund",
      requestedAmount: null,
      eligibleAmount: null,
      policyDecision: "undetermined",
      policyCitations: [citation],
      policyVersion: null,
      policyEffectiveDate: null,
      confidence: "low",
      ambiguities: [],
      riskFlags: [],
      actionsAlreadyTaken: [],
      toolFailures: [],
      escalationReason: "conflict",
      recommendedHumanAction: "review",
      provenance: [],
    };
    const result = validateEscalationPacket(packet, ctx);
    expect(result.valid).toBe(false);
  });
});
