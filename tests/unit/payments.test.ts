import { describe, expect, it, afterEach } from "vitest";
import { processRefund, getPaymentHistory, _resetPaymentsMockState } from "../../src/mock-backends/payments.js";

afterEach(() => _resetPaymentsMockState());

describe("payments mock: idempotency and balance checks", () => {
  it("replaying the same idempotencyKey returns the original transaction, never a duplicate", async () => {
    const input = { orderId: "ord_1001", customerId: "cust_001", amount: "10.00", currency: "USD", reason: "test", idempotencyKey: "case-1-refund-1" };
    const first = await processRefund(input);
    const second = await processRefund(input);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.replayed).toBe(true);
    }

    const history = await getPaymentHistory("ord_1001");
    expect(history.success).toBe(true);
    if (history.success) expect(history.refunds).toHaveLength(1); // not 2
  });

  it("rejects a refund exceeding the remaining refundable balance", async () => {
    const result = await processRefund({ orderId: "ord_1001", customerId: "cust_001", amount: "999.00", currency: "USD", reason: "test", idempotencyKey: "k1" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("REFUND_EXCEEDS_BALANCE");
  });

  it("rejects a currency mismatch against the order's currency", async () => {
    const result = await processRefund({ orderId: "ord_1001", customerId: "cust_001", amount: "10.00", currency: "EUR", reason: "test", idempotencyKey: "k2" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("CURRENCY_MISMATCH");
  });

  it("requires a non-empty idempotencyKey", async () => {
    const result = await processRefund({ orderId: "ord_1001", customerId: "cust_001", amount: "10.00", currency: "USD", reason: "test", idempotencyKey: "" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});
