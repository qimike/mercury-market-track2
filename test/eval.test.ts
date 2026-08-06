import { describe, it, expect, beforeEach } from "vitest";
import { runScenario } from "../src/eval/runEval.js";
import { scenarios } from "../src/eval/scenarios.js";
import { _resetPaymentsMockState } from "../src/mock-backends/payments.js";
import { _resetCaseManagementMockState } from "../src/mock-backends/caseManagement.js";

describe("evaluation suite (all seeded scenarios)", () => {
  beforeEach(() => {
    _resetPaymentsMockState();
    _resetCaseManagementMockState();
  });

  for (const scenario of scenarios) {
    it(`${scenario.id}: reaches the expected outcome (${scenario.expectedOutcome})`, async () => {
      const report = await runScenario(scenario);
      expect(report.outcomeCorrect, `expected ${scenario.expectedOutcome}, got ${report.actualOutcome}`).toBe(true);
      if (scenario.expectedReasonContains) {
        expect(report.reasonCorrect).toBe(true);
      }
      if (report.idempotencyCheck !== "n/a") {
        expect(report.idempotencyCheck).toBe("pass");
      }
      expect(report.noForbiddenSideEffect, "a refund executed on a case expected to escalate").toBe(true);
      if (report.refundAmountAccurate !== null) {
        expect(report.refundAmountAccurate).toBe(true);
      }
      expect(report.citationsTraceable, "a cited policy was never actually returned by evaluate_policy").toBe(true);
    });
  }
});
