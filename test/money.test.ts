import { describe, it, expect } from "vitest";
import { parseMoney, money, formatMoney, addMoney, subtractMoney, compareMoney, sumMoney } from "../src/domain/money.js";

describe("money", () => {
  it("parses decimal strings into integer minor units", () => {
    const result = parseMoney("42.50", "USD");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.minorUnits).toBe(4250);
  });

  it("rejects malformed decimal strings", () => {
    const result = parseMoney("forty-two", "USD");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorCategory).toBe("VALIDATION");
      expect(result.error.isRetryable).toBe(false);
    }
  });

  it("rejects precision beyond the currency's minor unit", () => {
    const result = parseMoney("42.505", "USD");
    expect(result.ok).toBe(false);
  });

  it("round-trips formatMoney(parseMoney(x)) === x", () => {
    expect(formatMoney(money("0.01", "USD"))).toBe("0.01");
    expect(formatMoney(money("1000.00", "USD"))).toBe("1000.00");
  });

  it("never uses floating point for arithmetic (classic 0.1 + 0.2 style case)", () => {
    const a = money("0.10", "USD");
    const b = money("0.20", "USD");
    expect(formatMoney(addMoney(a, b))).toBe("0.30");
  });

  it("subtracts and compares same-currency amounts", () => {
    const paid = money("50.00", "USD");
    const refunded = money("50.00", "USD");
    const remaining = subtractMoney(paid, refunded);
    expect(formatMoney(remaining)).toBe("0.00");
    expect(compareMoney(money("10.00", "USD"), money("5.00", "USD"))).toBe(1);
  });

  it("throws on cross-currency arithmetic", () => {
    expect(() => addMoney(money("1.00", "USD"), money("1.00", "EUR"))).toThrow(/currency mismatch/i);
  });

  it("sums a list of amounts", () => {
    const items = [money("10.00", "USD"), money("5.50", "USD"), money("0.50", "USD")];
    expect(formatMoney(sumMoney(items, "USD"))).toBe("16.00");
  });
});
