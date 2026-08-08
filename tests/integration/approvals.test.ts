import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { verifyCustomerIdentity } from "../../src/mock-backends/identity.js";
import { lookupOrder } from "../../src/mock-backends/oms.js";
import { evaluatePolicy } from "../../src/mock-backends/policy.js";
import { _resetPaymentsMockState } from "../../src/mock-backends/payments.js";
import { _resetReturnsMockState } from "../../src/mock-backends/returns.js";
import { buildSuggestionPacket, type SuggestionPacketDraft } from "../../src/domain/schemas/suggestionPacket.js";
import { recordSuggestionPacket, getSuggestionPacket, _resetPacketStoreMockState } from "../../src/advisor/packetStore.js";
import { approveAction, editAction, rejectAction, requestRevision } from "../../src/approvals/decide.js";
import { executeApprovedAction } from "../../src/approvals/execute.js";
import { lookupApproval, _resetApprovalStoreMockState } from "../../src/approvals/store.js";
import { classifyActionRisk, requiredApprovals } from "../../src/approvals/riskGate.js";

let citation: Awaited<ReturnType<typeof evaluatePolicy>> extends { success: true; citations: infer C } ? C : never;

beforeAll(async () => {
  await verifyCustomerIdentity("cust_001", "94107");
  const order = await lookupOrder("ord_1001", "cust_001");
  const policy = await evaluatePolicy({ region: "US", sku: "HOME-MUG-01", issueType: "return", deliveryDate: order.success ? order.order.deliveryDate : null, asOfDate: "2026-08-07", traceId: "t" });
  if (policy.success) citation = policy.citations as any;
});

afterEach(() => {
  _resetPaymentsMockState();
  _resetReturnsMockState();
  _resetPacketStoreMockState();
  _resetApprovalStoreMockState();
});

function makePacket(amount = "45.00"): ReturnType<typeof buildSuggestionPacket> {
  const draft: SuggestionPacketDraft = {
    caseId: "case_1",
    sessionId: "sess_1",
    customerIntent: "refund",
    caseSummary: "summary",
    identityStatus: "verified",
    issues: [{ issueId: "issue_1", issueType: "damaged_item", analysisSummary: "x", decision: "eligible", confidence: 0.9, customerClaimReferences: [], verifiedFactReferences: [], policyCitationReferences: [citation[0].policyId], missingInformation: [], risks: [] }],
    integratedRecommendation: { recommendedOutcome: "x", customerFacingDraft: "x", internalSummary: "x", conflictsDetected: [], unresolvedQuestions: [] },
    proposedActions: [{ actionId: "action_1", actionType: "propose_refund", description: "refund", parameters: { orderId: "ord_1001", customerId: "cust_001", amount, currency: "USD" }, executionStatus: "awaiting_approval", preconditions: [], blockingIssues: [], idempotencyKey: null }],
    policyCitations: citation.map((c: any) => ({ policyId: c.policyId, title: c.title, version: c.version, effectiveFrom: c.effectiveDate, effectiveTo: c.expirationDate, sourceReference: c.provenance.sourceId, relevantClauses: [c.excerpt], retrievedAt: c.provenance.retrievedAt })),
    dataProvenance: [{ sourceType: "policy", sourceReference: citation[0].policyId, retrievedAt: "2026-08-07T00:00:00.000Z", toolCallId: null, correlationId: null }],
    review: { status: "pass", blockingFindings: [], nonBlockingFindings: [], reviewedAt: "2026-08-07T00:00:00.000Z" },
    overallConfidence: 0.9,
  };
  const packet = buildSuggestionPacket(draft);
  recordSuggestionPacket(packet);
  return packet;
}

describe("human decision workflow (Pass 6/7)", () => {
  it("scenario: eligible recommendation remains unexecuted until approved", async () => {
    const packet = makePacket();
    expect(packet.proposedActions[0]?.executionStatus).toBe("awaiting_approval");
    const exec = await executeApprovedAction({ suggestionId: packet.suggestionId, actionId: "action_1", humanActorId: "human_1" });
    expect(exec.ok).toBe(false); // not approved yet
  });

  it("scenario: human approval executes an eligible refund", async () => {
    const packet = makePacket();
    const approval = approveAction(packet.suggestionId, "action_1", "human_1", "looks right");
    expect(approval.ok).toBe(true);
    const exec = await executeApprovedAction({ suggestionId: packet.suggestionId, actionId: "action_1", humanActorId: "human_1" });
    expect(exec.ok).toBe(true);
    if (exec.ok) expect(exec.transactionId).toBeTruthy();
    const stored = getSuggestionPacket(packet.suggestionId);
    expect(stored?.proposedActions[0]?.executionStatus).toBe("executed");
  });

  it("scenario: human rejection prevents execution", async () => {
    const packet = makePacket();
    rejectAction(packet.suggestionId, "action_1", "human_1", "not appropriate");
    const exec = await executeApprovedAction({ suggestionId: packet.suggestionId, actionId: "action_1", humanActorId: "human_1" });
    expect(exec.ok).toBe(false);
  });

  it("scenario: human edits the amount, invalidating prior approval and requiring re-approval", async () => {
    const packet = makePacket();
    approveAction(packet.suggestionId, "action_1", "human_1", "ok");
    const before = getSuggestionPacket(packet.suggestionId)!;
    expect(before.humanDecision.status).toBe("approved");

    const edited = editAction(packet.suggestionId, "action_1", { parameters: { orderId: "ord_1001", customerId: "cust_001", amount: "20.00", currency: "USD" } });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.packet.humanDecision.status).toBe("revision_requested");
    expect(edited.packet.proposedActions[0]?.actionHash).not.toBe(before.proposedActions[0]?.actionHash);
    expect(edited.packet.proposedActions[0]?.executionStatus).toBe("awaiting_approval");

    // Old approval record still points at the OLD hash — executing against the new
    // packet with stale executionContext must fail.
    const staleExec = await executeApprovedAction({ suggestionId: packet.suggestionId, actionId: "action_1", humanActorId: "human_1" });
    expect(staleExec.ok).toBe(false);

    // Re-approving under the new hash and executing succeeds.
    approveAction(packet.suggestionId, "action_1", "human_1", "re-approved after edit");
    const exec = await executeApprovedAction({ suggestionId: packet.suggestionId, actionId: "action_1", humanActorId: "human_1" });
    expect(exec.ok).toBe(true);
  });

  it("a description-only edit is persisted without invalidating approval or bumping the hash", async () => {
    const packet = makePacket();
    approveAction(packet.suggestionId, "action_1", "human_1", "ok");
    const edited = editAction(packet.suggestionId, "action_1", { description: "Refund the damaged mug (updated wording)" });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.packet.proposedActions[0]?.description).toBe("Refund the damaged mug (updated wording)");
    expect(edited.packet.proposedActions[0]?.actionHash).toBe(packet.proposedActions[0]?.actionHash);
    expect(edited.packet.humanDecision.status).toBe("approved"); // unchanged — not a material edit
    const stored = getSuggestionPacket(packet.suggestionId);
    expect(stored?.proposedActions[0]?.description).toBe("Refund the damaged mug (updated wording)");
  });

  it("scenario: a no-op edit (identical content) does not invalidate approval", async () => {
    const packet = makePacket();
    approveAction(packet.suggestionId, "action_1", "human_1", "ok");
    const edited = editAction(packet.suggestionId, "action_1", { parameters: { orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD" } });
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.packet.humanDecision.status).toBe("approved");
  });

  it("scenario: requestRevision clears prior approvals", async () => {
    const packet = makePacket();
    approveAction(packet.suggestionId, "action_1", "human_1", "ok");
    const revised = requestRevision(packet.suggestionId, "human_1", "need more detail");
    expect(revised.ok).toBe(true);
    if (revised.ok) {
      expect(revised.packet.humanDecision.status).toBe("revision_requested");
      expect(revised.packet.humanDecision.approvedActionHashes).toHaveLength(0);
    }
  });

  it("scenario: fork cannot execute a side effect using parent approval", async () => {
    const packet = makePacket();
    approveAction(packet.suggestionId, "action_1", "human_1", "ok", "parent_session_1");
    const approval = lookupApproval(packet.suggestionId, "action_1");
    expect(approval?.forkedFromSessionId).toBe("parent_session_1");
    const exec = await executeApprovedAction({ suggestionId: packet.suggestionId, actionId: "action_1", humanActorId: "human_1" });
    expect(exec.ok).toBe(false);
    expect(exec.ok === false && exec.error).toContain("");
  });

  it("scenario: duplicate idempotency key does not duplicate the refund", async () => {
    const packet = makePacket("10.00");
    approveAction(packet.suggestionId, "action_1", "human_1", "ok");
    const first = await executeApprovedAction({ suggestionId: packet.suggestionId, actionId: "action_1", humanActorId: "human_1" });
    const second = await executeApprovedAction({ suggestionId: packet.suggestionId, actionId: "action_1", humanActorId: "human_1" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false); // replay guard, not a second transaction
  });

  it("risk gate: a low-confidence/unverified-identity action requires 2 approvals", () => {
    const packet = makePacket();
    const highRisk = classifyActionRisk(packet.proposedActions[0]!, false, "low");
    expect(highRisk).toBe("high");
    expect(requiredApprovals(highRisk)).toBe(2);
    const standard = classifyActionRisk(packet.proposedActions[0]!, true, "high");
    expect(requiredApprovals(standard)).toBe(1);
  });
});
