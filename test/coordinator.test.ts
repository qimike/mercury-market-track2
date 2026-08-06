import { describe, it, expect, beforeEach } from "vitest";
import { runScenario } from "../src/eval/runEval.js";
import { scenarios } from "../src/eval/scenarios.js";
import { _resetPaymentsMockState } from "../src/mock-backends/payments.js";
import { _resetCaseManagementMockState } from "../src/mock-backends/caseManagement.js";

function scenario(id: string) {
  const found = scenarios.find((s) => s.id === id);
  if (!found) throw new Error(`missing fixture scenario ${id}`);
  return found;
}

describe("coordinator integration (via the deterministic autopilot)", () => {
  beforeEach(() => {
    _resetPaymentsMockState();
    _resetCaseManagementMockState();
  });

  it("resolves an eligible low-value refund autonomously with a real refund transaction and policy citation", async () => {
    const report = await runScenario(scenario("eligible_low_value_refund"));
    expect(report.outcomeCorrect).toBe(true);
    expect(report.toolsUsed).toContain("process_refund");
    expect(report.toolsUsed).toContain("resolve_case");
  });

  it("never calls process_refund or create_return for an unverified customer", async () => {
    const report = await runScenario(scenario("unverified_customer"));
    expect(report.outcomeCorrect).toBe(true);
    expect(report.toolsUsed).not.toContain("process_refund");
    expect(report.toolsUsed).not.toContain("create_return");
  });

  it("escalates a policy conflict without ever calling process_refund", async () => {
    const report = await runScenario(scenario("policy_conflict"));
    expect(report.outcomeCorrect).toBe(true);
    expect(report.toolsUsed).not.toContain("process_refund");
  });

  it("escalates a locked account immediately, never attempting verify_customer_identity", async () => {
    const report = await runScenario(scenario("locked_account"));
    expect(report.outcomeCorrect).toBe(true);
    expect(report.toolsUsed).not.toContain("verify_customer_identity");
    expect(report.iterations).toBeLessThanOrEqual(2);
  });

  it("escalates a high-value refund without ever calling process_refund", async () => {
    const report = await runScenario(scenario("high_value_refund"));
    expect(report.outcomeCorrect).toBe(true);
    expect(report.toolsUsed).not.toContain("process_refund");
  });
});
