import { describe, expect, it, afterEach } from "vitest";
import { validateSuggestionPacket } from "../../src/agent/validation.js";
import { buildSuggestionPacket, type SuggestionPacketDraft } from "../../src/domain/schemas/suggestionPacket.js";
import { CaseContext } from "../../src/agent/context.js";
import type { PolicyCitation } from "../../src/domain/schemas.js";

function ctxWithCitation(currency = "USD"): CaseContext {
  const ctx = new CaseContext("case_1", "trace_1");
  ctx.currency = currency;
  const citation: PolicyCitation = {
    policyId: "POL-RETURN-GLOBAL",
    version: "3",
    title: "Global return policy",
    region: "ALL",
    skuScope: "ALL",
    effectiveDate: "2026-01-01",
    expirationDate: null,
    excerpt: "30 day window",
    provenance: { sourceType: "policy_document", sourceId: "policies/global-standard-return.md", policyId: "POL-RETURN-GLOBAL", policyVersion: "3", effectiveDate: "2026-01-01", retrievedAt: "2026-08-07T00:00:00.000Z", traceId: "trace_1" },
  };
  ctx.seenPolicyCitations.set(citation.policyId, citation);
  return ctx;
}

function draft(overrides: Partial<SuggestionPacketDraft> = {}): SuggestionPacketDraft {
  return {
    caseId: "case_1",
    sessionId: "sess_1",
    customerIntent: "refund",
    caseSummary: "summary",
    identityStatus: "verified",
    issues: [
      {
        issueId: "issue_1",
        issueType: "damaged_item",
        analysisSummary: "x",
        decision: "eligible",
        confidence: 0.9,
        customerClaimReferences: [],
        verifiedFactReferences: [],
        policyCitationReferences: ["POL-RETURN-GLOBAL"],
        missingInformation: [],
        risks: [],
      },
    ],
    integratedRecommendation: { recommendedOutcome: "x", customerFacingDraft: "x", internalSummary: "x", conflictsDetected: [], unresolvedQuestions: [] },
    proposedActions: [
      {
        actionId: "action_1",
        actionType: "propose_refund",
        description: "refund",
        parameters: { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD" },
        executionStatus: "awaiting_approval",
        preconditions: [],
        blockingIssues: [],
        idempotencyKey: null,
      },
    ],
    policyCitations: [{ policyId: "POL-RETURN-GLOBAL", title: "x", version: "3", effectiveFrom: "2026-01-01", effectiveTo: null, sourceReference: "x", relevantClauses: [], retrievedAt: "2026-08-07T00:00:00.000Z" }],
    dataProvenance: [{ sourceType: "policy", sourceReference: "POL-RETURN-GLOBAL", retrievedAt: "2026-08-07T00:00:00.000Z", toolCallId: null, correlationId: null }],
    review: { status: "pass", blockingFindings: [], nonBlockingFindings: [], reviewedAt: "2026-08-07T00:00:00.000Z" },
    overallConfidence: 0.9,
    ...overrides,
  };
}

describe("validateSuggestionPacket (Pass 4/5 semantic gate)", () => {
  it("accepts a valid, evidence-backed packet", () => {
    const packet = buildSuggestionPacket(draft());
    const result = validateSuggestionPacket(packet, ctxWithCitation());
    expect(result.valid).toBe(true);
  });

  it("rejects a citation never seen this case (anti-fabrication)", () => {
    const packet = buildSuggestionPacket(draft());
    const emptyCtx = new CaseContext("case_1", "trace_1");
    emptyCtx.currency = "USD";
    const result = validateSuggestionPacket(packet, emptyCtx);
    expect(result.valid).toBe(false);
  });

  it("rejects an 'eligible' issue with zero policy citations (unsupported certainty, spec Example B)", () => {
    const packet = buildSuggestionPacket(
      draft({ issues: [{ ...draft().issues[0]!, policyCitationReferences: [] }] })
    );
    const result = validateSuggestionPacket(packet, ctxWithCitation());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.message.includes("zero policyCitationReferences"))).toBe(true);
  });

  it("rejects a currency mismatch between proposed amount and case currency", () => {
    const packet = buildSuggestionPacket(
      draft({ proposedActions: [{ ...draft().proposedActions[0]!, parameters: { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "EUR" } }] })
    );
    const result = validateSuggestionPacket(packet, ctxWithCitation("USD"));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.message.includes("currency"))).toBe(true);
  });

  it("rejects a proposed amount exceeding the known remaining refundable balance", () => {
    const ctx = ctxWithCitation();
    ctx.knownRemainingRefundableAmount = { amount: "10.00", currency: "USD" };
    const packet = buildSuggestionPacket(draft()); // proposes 45.00
    const result = validateSuggestionPacket(packet, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.message.includes("exceeds"))).toBe(true);
  });

  it("rejects mismatched line-item arithmetic", () => {
    const packet = buildSuggestionPacket(
      draft({
        proposedActions: [
          {
            ...draft().proposedActions[0]!,
            parameters: {
              orderId: "ord_1001",
              customerId: "cust_001",
              amount: "45.00",
              currency: "USD",
              lineItems: [{ sku: "HOME-MUG-01", lineTotal: "20.00" }], // sums to 20.00, not 45.00
            },
          },
        ],
      })
    );
    const result = validateSuggestionPacket(packet, ctxWithCitation());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.message.includes("do not sum"))).toBe(true);
  });

  it("detects duplicate compensation: two proposed money-moving actions targeting the same order", () => {
    const base = draft();
    const packet = buildSuggestionPacket({
      ...base,
      proposedActions: [
        base.proposedActions[0]!,
        { ...base.proposedActions[0]!, actionId: "action_2", parameters: { ...base.proposedActions[0]!.parameters, amount: "10.00" } },
      ],
    });
    const result = validateSuggestionPacket(packet, ctxWithCitation());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.message.includes("duplicate compensation"))).toBe(true);
  });

  it("rejects a packet whose review.status is already blocked", () => {
    const packet = buildSuggestionPacket(draft({ review: { status: "blocked", blockingFindings: ["x"], nonBlockingFindings: [], reviewedAt: "2026-08-07T00:00:00.000Z" } }));
    const result = validateSuggestionPacket(packet, ctxWithCitation());
    expect(result.valid).toBe(false);
  });
});
