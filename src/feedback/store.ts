/**
 * Human-in-the-loop feedback store (spec section 17). Reviewers record
 * whether they approved, modified, or rejected the agent's recommendation
 * for an escalated (or, retrospectively, autonomously resolved) case, plus
 * what the correct policy/amount/reason should have been. src/feedback/report.ts
 * turns this into an agent-vs-human comparison report.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";

export interface HumanFeedbackRecord {
  feedbackId: string;
  caseId: string;
  reviewerId: string;
  decision: "approved" | "modified" | "rejected";
  correctPolicyId: string | null;
  correctEligibleAmount: { amount: string; currency: string } | null;
  correctEscalationReason: string | null;
  notes: string | null;
  recordedAt: string;
}

export interface RecordFeedbackInput {
  caseId: string;
  reviewerId: string;
  decision: HumanFeedbackRecord["decision"];
  correctPolicyId?: string | null;
  correctEligibleAmount?: { amount: string; currency: string } | null;
  correctEscalationReason?: string | null;
  notes?: string | null;
}

let seq = 0;
const feedback: HumanFeedbackRecord[] = [];

export function recordFeedback(input: RecordFeedbackInput): HumanFeedbackRecord {
  seq += 1;
  const record: HumanFeedbackRecord = {
    feedbackId: `fb_${String(seq).padStart(4, "0")}`,
    caseId: input.caseId,
    reviewerId: input.reviewerId,
    decision: input.decision,
    correctPolicyId: input.correctPolicyId ?? null,
    correctEligibleAmount: input.correctEligibleAmount ?? null,
    correctEscalationReason: input.correctEscalationReason ?? null,
    notes: input.notes ?? null,
    recordedAt: new Date().toISOString(),
  };
  feedback.push(record);
  return record;
}

export function getFeedbackForCase(caseId: string): HumanFeedbackRecord[] {
  return feedback.filter((f) => f.caseId === caseId);
}

export function listAllFeedback(): HumanFeedbackRecord[] {
  return [...feedback];
}

export function saveFeedbackToFile(path: string): void {
  writeFileSync(path, JSON.stringify(feedback, null, 2), "utf-8");
}

export function loadFeedbackFromFile(path: string): void {
  if (!existsSync(path)) return;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as HumanFeedbackRecord[];
  feedback.length = 0;
  feedback.push(...parsed);
  seq = feedback.length;
}

export function _resetFeedbackStore(): void {
  feedback.length = 0;
  seq = 0;
}
