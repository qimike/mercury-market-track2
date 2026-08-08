import { describe, expect, it } from "vitest";
import { buildSuggestionPacket, recomputeActionHash, SuggestionPacketSchema, type SuggestionPacketDraft } from "../../src/domain/schemas/suggestionPacket.js";

function baseDraft(): SuggestionPacketDraft {
  return {
    caseId: "case_1",
    sessionId: "sess_1",
    customerIntent: "Refund a damaged item",
    caseSummary: "Customer received a damaged mug",
    identityStatus: "verified",
    issues: [
      {
        issueId: "issue_1",
        issueType: "damaged_item",
        analysisSummary: "Item arrived broken",
        decision: "eligible",
        confidence: 0.9,
        customerClaimReferences: ["claim_1"],
        verifiedFactReferences: ["order_1"],
        policyCitationReferences: ["POL-RETURN-GLOBAL"],
        missingInformation: [],
        risks: [],
      },
    ],
    integratedRecommendation: {
      recommendedOutcome: "Refund the item",
      customerFacingDraft: "We'll refund your order.",
      internalSummary: "Eligible per policy",
      conflictsDetected: [],
      unresolvedQuestions: [],
    },
    proposedActions: [
      {
        actionId: "action_1",
        actionType: "propose_refund",
        description: "Refund $45",
        parameters: { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD" },
        executionStatus: "awaiting_approval",
        preconditions: [],
        blockingIssues: [],
        idempotencyKey: null,
      },
    ],
    policyCitations: [
      { policyId: "POL-RETURN-GLOBAL", title: "Global return policy", version: "3", effectiveFrom: "2026-01-01", effectiveTo: null, sourceReference: "policies/global-standard-return.md", relevantClauses: ["30 day window"], retrievedAt: "2026-08-07T00:00:00.000Z" },
    ],
    dataProvenance: [],
    review: { status: "pass", blockingFindings: [], nonBlockingFindings: [], reviewedAt: "2026-08-07T00:00:00.000Z" },
    overallConfidence: 0.9,
  };
}

describe("SuggestionPacket schema + hashing", () => {
  it("builds a schema-valid packet", () => {
    const packet = buildSuggestionPacket(baseDraft());
    expect(() => SuggestionPacketSchema.parse(packet)).not.toThrow();
    expect(packet.suggestionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.proposedActions[0]?.actionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.humanReviewRequired).toBe(true);
    expect(packet.humanDecision.status).toBe("pending");
  });

  it("produces the same hash for identical content built twice", () => {
    const draft = baseDraft();
    const a = buildSuggestionPacket({ ...draft, createdAt: "2026-08-07T00:00:00.000Z" });
    const b = buildSuggestionPacket({ ...draft, createdAt: "2026-08-07T00:00:00.000Z" });
    expect(a.suggestionHash).toBe(b.suggestionHash);
    expect(a.proposedActions[0]?.actionHash).toBe(b.proposedActions[0]?.actionHash);
  });

  it("changes the suggestionHash when a proposed action's parameters change", () => {
    const draft = baseDraft();
    const a = buildSuggestionPacket(draft);
    const draft2 = { ...draft, proposedActions: [{ ...draft.proposedActions[0]!, parameters: { ...draft.proposedActions[0]!.parameters, amount: "99.00" } }] };
    const b = buildSuggestionPacket(draft2);
    expect(a.suggestionHash).not.toBe(b.suggestionHash);
    expect(a.proposedActions[0]?.actionHash).not.toBe(b.proposedActions[0]?.actionHash);
  });

  it("does not change the hash when only createdAt differs (for a fixed suggestionId)", () => {
    const draft = { ...baseDraft(), suggestionId: "suggestion_fixed" };
    const a = buildSuggestionPacket({ ...draft, createdAt: "2026-01-01T00:00:00.000Z" });
    const b = buildSuggestionPacket({ ...draft, createdAt: "2026-12-31T23:59:59.000Z" });
    expect(a.suggestionHash).toBe(b.suggestionHash);
  });

  it("recomputeActionHash matches the hash produced by buildSuggestionPacket for equivalent content", () => {
    const packet = buildSuggestionPacket(baseDraft());
    const action = packet.proposedActions[0]!;
    const recomputed = recomputeActionHash(action);
    expect(recomputed).toBe(action.actionHash);
  });

  it("recomputeActionHash produces a different hash after an edit", () => {
    const packet = buildSuggestionPacket(baseDraft());
    const action = packet.proposedActions[0]!;
    const edited = recomputeActionHash({ ...action, parameters: { ...action.parameters, amount: "10.00" } });
    expect(edited).not.toBe(action.actionHash);
  });
});
