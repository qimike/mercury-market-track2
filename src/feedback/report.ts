/**
 * Builds the agent-vs-human comparison report (spec section 17): for every
 * case with recorded human feedback, compares the agent's actual decision
 * (resolved autonomously vs. escalated, with what confidence/amount/citation)
 * against what the reviewer says should have happened.
 */

import { listEscalations, getResolution } from "../mock-backends/caseManagement.js";
import { listAllFeedback, type HumanFeedbackRecord } from "./store.js";
import { parseMoney, subtractMoney, formatMoney } from "../domain/money.js";

export interface CaseComparisonRow {
  caseId: string;
  agentDecision: "resolved_autonomously" | "escalated" | "unknown";
  agentConfidence: string | null;
  humanDecision: HumanFeedbackRecord["decision"];
  escalationCorrect: boolean | null;
  refundAmountDifference: string | null;
  citationCorrect: boolean | null;
  notes: string | null;
}

export interface ComparisonReport {
  rows: CaseComparisonRow[];
  summary: {
    totalReviewed: number;
    approved: number;
    modified: number;
    rejected: number;
    escalationCorrectnessRate: number | null;
    citationCorrectnessRate: number | null;
  };
}

function findAgentDecisionForCase(caseId: string): {
  kind: "resolved_autonomously" | "escalated" | "unknown";
  confidence: string | null;
  eligibleAmount: { amount: string; currency: string } | null;
  citedPolicyIds: string[];
} {
  const resolution = getResolution(caseId);
  if (resolution) {
    return {
      kind: "resolved_autonomously",
      confidence: null,
      eligibleAmount: resolution.refundAmount,
      citedPolicyIds: resolution.policyCitations.map((c) => c.policyId),
    };
  }
  const escalation = listEscalations().find((e) => e.packet.caseId === caseId);
  if (escalation) {
    return {
      kind: "escalated",
      confidence: escalation.packet.confidence,
      eligibleAmount: escalation.packet.eligibleAmount,
      citedPolicyIds: escalation.packet.policyCitations.map((c) => c.policyId),
    };
  }
  return { kind: "unknown", confidence: null, eligibleAmount: null, citedPolicyIds: [] };
}

export function buildComparisonReport(): ComparisonReport {
  const rows: CaseComparisonRow[] = [];

  for (const fb of listAllFeedback()) {
    const agent = findAgentDecisionForCase(fb.caseId);

    let escalationCorrect: boolean | null = null;
    if (fb.decision === "approved") escalationCorrect = true;
    else if (fb.decision === "rejected") escalationCorrect = false;
    // "modified" means the routing (resolve vs escalate) was right but details were off.
    else if (fb.decision === "modified") escalationCorrect = true;

    let refundAmountDifference: string | null = null;
    if (fb.correctEligibleAmount && agent.eligibleAmount) {
      const correct = parseMoney(fb.correctEligibleAmount.amount, fb.correctEligibleAmount.currency);
      const actual = parseMoney(agent.eligibleAmount.amount, agent.eligibleAmount.currency);
      if (correct.ok && actual.ok && correct.value.currency === actual.value.currency) {
        refundAmountDifference = formatMoney(subtractMoney(actual.value, correct.value));
      }
    }

    const citationCorrect =
      fb.correctPolicyId === null ? null : agent.citedPolicyIds.includes(fb.correctPolicyId);

    rows.push({
      caseId: fb.caseId,
      agentDecision: agent.kind,
      agentConfidence: agent.confidence,
      humanDecision: fb.decision,
      escalationCorrect,
      refundAmountDifference,
      citationCorrect,
      notes: fb.notes,
    });
  }

  const withEscalationVerdict = rows.filter((r) => r.escalationCorrect !== null);
  const withCitationVerdict = rows.filter((r) => r.citationCorrect !== null);

  return {
    rows,
    summary: {
      totalReviewed: rows.length,
      approved: rows.filter((r) => r.humanDecision === "approved").length,
      modified: rows.filter((r) => r.humanDecision === "modified").length,
      rejected: rows.filter((r) => r.humanDecision === "rejected").length,
      escalationCorrectnessRate:
        withEscalationVerdict.length > 0
          ? withEscalationVerdict.filter((r) => r.escalationCorrect).length / withEscalationVerdict.length
          : null,
      citationCorrectnessRate:
        withCitationVerdict.length > 0
          ? withCitationVerdict.filter((r) => r.citationCorrect).length / withCitationVerdict.length
          : null,
    },
  };
}
