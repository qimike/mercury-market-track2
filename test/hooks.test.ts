import { describe, it, expect } from "vitest";
import { runPreToolHooks, type HookContext } from "../src/agent/hooks.js";

function ctx(overrides: Partial<HookContext> = {}): HookContext {
  return { caseId: "case_1", identityStatus: "unverified", ...overrides };
}

describe("programmatic hooks", () => {
  it("blocks lookup_order for an unverified customer", () => {
    const decision = runPreToolHooks("lookup_order", { orderId: "ord_1001" }, ctx());
    expect(decision.allow).toBe(false);
    expect(decision.blockedError?.errorCode).toBe("IDENTITY_NOT_VERIFIED");
  });

  it("blocks process_refund for an unverified customer even with a valid amount", () => {
    const decision = runPreToolHooks(
      "process_refund",
      { orderId: "ord_1001", amount: "10.00", currency: "USD" },
      ctx()
    );
    expect(decision.allow).toBe(false);
    expect(decision.blockedError?.errorCode).toBe("IDENTITY_NOT_VERIFIED");
  });

  it("allows lookup_order once identity is verified", () => {
    const decision = runPreToolHooks("lookup_order", { orderId: "ord_1001" }, ctx({ identityStatus: "verified" }));
    expect(decision.allow).toBe(true);
  });

  it("blocks a locked account even for read-only customer-specific tools", () => {
    const decision = runPreToolHooks("lookup_order", { orderId: "ord_1001" }, ctx({ identityStatus: "locked" }));
    expect(decision.allow).toBe(false);
    expect(decision.blockedError?.errorCode).toBe("ACCOUNT_LOCKED");
    expect(decision.forceEscalation).toBe(true);
  });

  it("does not require identity verification for non-customer-specific tools like evaluate_policy", () => {
    const decision = runPreToolHooks("evaluate_policy", { region: "US", sku: "X" }, ctx());
    expect(decision.allow).toBe(true);
  });

  it("blocks a refund at/above the mandatory escalation threshold regardless of verification or policy", () => {
    const decision = runPreToolHooks(
      "process_refund",
      { orderId: "ord_1003", amount: "799.99", currency: "USD" },
      ctx({ identityStatus: "verified", policyDecision: "eligible", policyConfidence: "high" })
    );
    expect(decision.allow).toBe(false);
    expect(decision.blockedError?.errorCode).toBe("REFUND_THRESHOLD_EXCEEDED");
    expect(decision.forceEscalation).toBe(true);
  });

  it("blocks a refund whose currency does not match the case currency", () => {
    const decision = runPreToolHooks(
      "process_refund",
      { orderId: "ord_1013", amount: "45.00", currency: "EUR" },
      ctx({ identityStatus: "verified", caseCurrency: "USD" })
    );
    expect(decision.allow).toBe(false);
    expect(decision.blockedError?.errorCode).toBe("CURRENCY_MISMATCH");
  });

  it("blocks a refund exceeding the known remaining refundable balance", () => {
    const decision = runPreToolHooks(
      "process_refund",
      { orderId: "ord_1010", amount: "120.00", currency: "USD" },
      ctx({
        identityStatus: "verified",
        knownRemainingRefundableAmount: { amount: "50.00", currency: "USD" },
        policyDecision: "eligible",
        policyConfidence: "high",
      })
    );
    expect(decision.allow).toBe(false);
    expect(decision.blockedError?.errorCode).toBe("REFUND_EXCEEDS_BALANCE");
  });

  it("deterministically derives the idempotencyKey from caseId+orderId, ignoring whatever the model supplied", () => {
    const decision = runPreToolHooks(
      "process_refund",
      { orderId: "ord_1001", amount: "10.00", currency: "USD", idempotencyKey: "whatever-the-model-made-up" },
      ctx({ identityStatus: "verified", policyDecision: "eligible", policyConfidence: "high" })
    );
    expect(decision.allow).toBe(true);
    expect(decision.overrideInput?.idempotencyKey).toBe("case_1:refund:ord_1001");

    const decisionAgain = runPreToolHooks(
      "process_refund",
      { orderId: "ord_1001", amount: "10.00", currency: "USD", idempotencyKey: "a-completely-different-value" },
      ctx({ identityStatus: "verified", policyDecision: "eligible", policyConfidence: "high" })
    );
    expect(decisionAgain.overrideInput?.idempotencyKey).toBe(decision.overrideInput?.idempotencyKey);
  });

  it("allows a low-value refund for a verified customer with a high-confidence eligible policy and no conflicting facts", () => {
    const decision = runPreToolHooks(
      "process_refund",
      { orderId: "ord_1001", amount: "45.00", currency: "USD" },
      ctx({ identityStatus: "verified", caseCurrency: "USD", policyDecision: "eligible", policyConfidence: "high" })
    );
    expect(decision.allow).toBe(true);
    expect(decision.forceEscalation).toBe(false);
  });

  it("blocks a refund when no policy has been evaluated this case yet", () => {
    const decision = runPreToolHooks(
      "process_refund",
      { orderId: "ord_1001", amount: "45.00", currency: "USD" },
      ctx({ identityStatus: "verified", caseCurrency: "USD" })
    );
    expect(decision.allow).toBe(false);
    expect(decision.blockedError?.errorCode).toBe("POLICY_NOT_ELIGIBLE_FOR_AUTONOMOUS_REFUND");
    expect(decision.blockedError?.errorCategory).toBe("POLICY_AMBIGUITY");
    expect(decision.forceEscalation).toBe(true);
  });

  it("blocks a refund when policy confidence is only medium, even if the decision is eligible", () => {
    const decision = runPreToolHooks(
      "process_refund",
      { orderId: "ord_1001", amount: "45.00", currency: "USD" },
      ctx({ identityStatus: "verified", caseCurrency: "USD", policyDecision: "eligible", policyConfidence: "medium" })
    );
    expect(decision.allow).toBe(false);
    expect(decision.blockedError?.errorCode).toBe("POLICY_NOT_ELIGIBLE_FOR_AUTONOMOUS_REFUND");
  });

  it("blocks a refund when the policy decision is undetermined (conflict/staleness), even at high confidence", () => {
    const decision = runPreToolHooks(
      "process_refund",
      { orderId: "ord_1001", amount: "45.00", currency: "USD" },
      ctx({ identityStatus: "verified", caseCurrency: "USD", policyDecision: "undetermined", policyConfidence: "high" })
    );
    expect(decision.allow).toBe(false);
  });
});
