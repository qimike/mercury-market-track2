import { describe, it, expect, beforeEach } from "vitest";
import { getPaymentHistory, processRefund, _resetPaymentsMockState } from "../src/mock-backends/payments.js";

describe("payments mock backend", () => {
  beforeEach(() => {
    _resetPaymentsMockState();
  });

  it("returns an empty refunds array (not an error) when there are no prior refunds", async () => {
    const result = await getPaymentHistory("ord_1006");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.refunds).toEqual([]);
      expect(result.remainingRefundableAmount).toBe("32.00");
    }
  });

  it("fails NOT_FOUND for a nonexistent order", async () => {
    const result = await getPaymentHistory("ord_does_not_exist");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("ORDER_NOT_FOUND");
  });

  it("requires a non-empty idempotencyKey", async () => {
    const result = await processRefund({
      orderId: "ord_1001",
      customerId: "cust_001",
      amount: "10.00",
      currency: "USD",
      reason: "test",
      idempotencyKey: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("rejects a currency that does not match the order's currency", async () => {
    const result = await processRefund({
      orderId: "ord_1001",
      customerId: "cust_001",
      amount: "10.00",
      currency: "EUR",
      reason: "test",
      idempotencyKey: "k1",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("CURRENCY_MISMATCH");
  });

  it("rejects a refund exceeding the remaining refundable balance", async () => {
    const result = await processRefund({
      orderId: "ord_1010",
      customerId: "cust_010",
      amount: "120.00",
      currency: "USD",
      reason: "test",
      idempotencyKey: "k2",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("REFUND_EXCEEDS_BALANCE");
  });

  it("processes a valid refund and replaying the same idempotencyKey never creates a duplicate", async () => {
    const first = await processRefund({
      orderId: "ord_1001",
      customerId: "cust_001",
      amount: "45.00",
      currency: "USD",
      reason: "eligible return",
      idempotencyKey: "same-key",
    });
    expect(first.success).toBe(true);
    const second = await processRefund({
      orderId: "ord_1001",
      customerId: "cust_001",
      amount: "45.00",
      currency: "USD",
      reason: "eligible return",
      idempotencyKey: "same-key",
    });
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.replayed).toBe(true);
      expect(first.replayed).toBe(false);
    }

    const history = await getPaymentHistory("ord_1001");
    expect(history.success).toBe(true);
    if (history.success) expect(history.refunds).toHaveLength(1);
  });

  it("simulates one transient failure then success for the flaky-gateway order", async () => {
    const attempt1 = await processRefund({
      orderId: "ord_1007",
      customerId: "cust_007",
      amount: "60.00",
      currency: "USD",
      reason: "test",
      idempotencyKey: "flaky-key",
    });
    expect(attempt1.success).toBe(false);
    if (!attempt1.success) {
      expect(attempt1.error.errorCategory).toBe("DEPENDENCY");
      expect(attempt1.error.isRetryable).toBe(true);
    }

    const attempt2 = await processRefund({
      orderId: "ord_1007",
      customerId: "cust_007",
      amount: "60.00",
      currency: "USD",
      reason: "test",
      idempotencyKey: "flaky-key",
    });
    expect(attempt2.success).toBe(true);
  });

  it("always fails for the permanently-down gateway order (retry exhaustion candidate)", async () => {
    for (let i = 0; i < 3; i += 1) {
      const attempt = await processRefund({
        orderId: "ord_1008",
        customerId: "cust_008",
        amount: "60.00",
        currency: "USD",
        reason: "test",
        idempotencyKey: `always-down-${i}`,
      });
      expect(attempt.success).toBe(false);
    }
  });
});
