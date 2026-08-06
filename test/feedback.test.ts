import { describe, it, expect, beforeEach } from "vitest";
import { recordFeedback, getFeedbackForCase, _resetFeedbackStore } from "../src/feedback/store.js";
import { buildComparisonReport } from "../src/feedback/report.js";
import { _resetCaseManagementMockState, recordResolution } from "../src/mock-backends/caseManagement.js";

describe("human-in-the-loop feedback", () => {
  beforeEach(() => {
    _resetFeedbackStore();
    _resetCaseManagementMockState();
  });

  it("records and retrieves feedback for a case", () => {
    const record = recordFeedback({ caseId: "case_1", reviewerId: "rev_1", decision: "approved" });
    expect(record.feedbackId).toBeTruthy();
    expect(getFeedbackForCase("case_1")).toHaveLength(1);
  });

  it("builds a comparison report showing agent decision vs human decision", async () => {
    await recordResolution({
      caseId: "case_1",
      outcome: "resolved_autonomously",
      customerSummary: "x",
      internalSummary: "x",
      refundTransactionId: "txn_1",
      refundAmount: { amount: "45.00", currency: "USD" },
      policyCitations: [],
      actionsTaken: [],
      provenance: [],
    });
    recordFeedback({
      caseId: "case_1",
      reviewerId: "rev_1",
      decision: "modified",
      correctEligibleAmount: { amount: "40.00", currency: "USD" },
      notes: "should have been $40",
    });

    const report = buildComparisonReport();
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.agentDecision).toBe("resolved_autonomously");
    expect(report.rows[0]?.refundAmountDifference).toBe("5.00");
    expect(report.summary.totalReviewed).toBe(1);
  });
});
