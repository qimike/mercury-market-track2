import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { verifyCustomerIdentity } from "../../src/mock-backends/identity.js";
import { lookupOrder } from "../../src/mock-backends/oms.js";
import { evaluatePolicy } from "../../src/mock-backends/policy.js";
import { _resetPaymentsMockState } from "../../src/mock-backends/payments.js";
import { buildSuggestionPacket, type SuggestionPacketDraft } from "../../src/domain/schemas/suggestionPacket.js";
import { recordSuggestionPacket, _resetPacketStoreMockState } from "../../src/advisor/packetStore.js";
import { approveAction } from "../../src/approvals/decide.js";
import { executeApprovedAction } from "../../src/approvals/execute.js";
import { _resetApprovalStoreMockState } from "../../src/approvals/store.js";
import { buildAuditTimeline } from "../../src/audit/auditLog.js";

let citation: any;
beforeAll(async () => {
  await verifyCustomerIdentity("cust_001", "94107");
  const order = await lookupOrder("ord_1001", "cust_001");
  const policy = await evaluatePolicy({ region: "US", sku: "HOME-MUG-01", issueType: "return", deliveryDate: order.success ? order.order.deliveryDate : null, asOfDate: "2026-08-07", traceId: "t" });
  if (policy.success) citation = policy.citations;
});

afterEach(() => {
  _resetPaymentsMockState();
  _resetPacketStoreMockState();
  _resetApprovalStoreMockState();
});

describe("buildAuditTimeline dedupe", () => {
  it("does not emit duplicate 'submitted' or 'human decision' entries across approve+execute within one process", async () => {
    const draft: SuggestionPacketDraft = {
      caseId: "case_audit_1",
      sessionId: "sess_audit_1",
      customerIntent: "refund",
      caseSummary: "summary",
      identityStatus: "verified",
      issues: [{ issueId: "issue_1", issueType: "damaged_item", analysisSummary: "x", decision: "eligible", confidence: 0.9, customerClaimReferences: [], verifiedFactReferences: [], policyCitationReferences: [citation[0].policyId], missingInformation: [], risks: [] }],
      integratedRecommendation: { recommendedOutcome: "x", customerFacingDraft: "x", internalSummary: "x", conflictsDetected: [], unresolvedQuestions: [] },
      proposedActions: [{ actionId: "action_1", actionType: "propose_refund", description: "refund", parameters: { orderId: "ord_1001", customerId: "cust_001", amount: "10.00", currency: "USD" }, executionStatus: "awaiting_approval", preconditions: [], blockingIssues: [], idempotencyKey: null }],
      policyCitations: citation.map((c: any) => ({ policyId: c.policyId, title: c.title, version: c.version, effectiveFrom: c.effectiveDate, effectiveTo: c.expirationDate, sourceReference: c.provenance.sourceId, relevantClauses: [c.excerpt], retrievedAt: c.provenance.retrievedAt })),
      dataProvenance: [{ sourceType: "policy", sourceReference: citation[0].policyId, retrievedAt: "2026-08-07T00:00:00.000Z", toolCallId: null, correlationId: null }],
      review: { status: "pass", blockingFindings: [], nonBlockingFindings: [], reviewedAt: "2026-08-07T00:00:00.000Z" },
      overallConfidence: 0.9,
    };
    const packet = buildSuggestionPacket(draft);
    recordSuggestionPacket(packet);
    approveAction(packet.suggestionId, "action_1", "human_1", "ok");
    await executeApprovedAction({ suggestionId: packet.suggestionId, actionId: "action_1", humanActorId: "human_1" });

    const timeline = await buildAuditTimeline("case_audit_1");
    const submittedEntries = timeline.filter((e) => e.kind === "advisor_analysis");
    const decisionEntries = timeline.filter((e) => e.kind === "human_decision");
    const executionEntries = timeline.filter((e) => e.kind === "execution_result");

    expect(submittedEntries).toHaveLength(1);
    expect(decisionEntries).toHaveLength(1);
    expect(executionEntries).toHaveLength(1);
  });
});
