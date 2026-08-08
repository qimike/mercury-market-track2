import { describe, expect, it } from "vitest";
import { parseMoney, money, formatMoney, addMoney, subtractMoney, compareMoney, sumMoney, isZeroOrNegative } from "../../src/domain/money.js";

describe("money (decimal-safe arithmetic)", () => {
  it("parses a valid decimal string into integer minor units", () => {
    const result = parseMoney("42.50", "USD");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ currency: "USD", minorUnits: 4250 });
  });

  it("rejects a non-decimal string", () => {
    const result = parseMoney("forty-two", "USD");
    expect(result.ok).toBe(false);
  });

  it("rejects excess precision for a 2-decimal currency", () => {
    const result = parseMoney("42.123", "USD");
    expect(result.ok).toBe(false);
  });

  it("handles zero-decimal currencies (JPY)", () => {
    const result = parseMoney("500", "JPY");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.minorUnits).toBe(500);
  });

  it("never uses binary floating point for arithmetic", () => {
    const a = money("0.10", "USD");
    const b = money("0.20", "USD");
    expect(formatMoney(addMoney(a, b))).toBe("0.30"); // would be 0.30000000000000004 with naive floats
  });

  it("subtracts and compares", () => {
    const a = money("10.00", "USD");
    const b = money("4.50", "USD");
    expect(formatMoney(subtractMoney(a, b))).toBe("5.50");
    expect(compareMoney(a, b)).toBe(1);
  });

  it("throws on cross-currency arithmetic", () => {
    expect(() => addMoney(money("1.00", "USD"), money("1.00", "EUR"))).toThrow();
  });

  it("sums a list of amounts", () => {
    const total = sumMoney([money("1.00", "USD"), money("2.50", "USD")], "USD");
    expect(formatMoney(total)).toBe("3.50");
  });

  it("detects zero/negative amounts", () => {
    expect(isZeroOrNegative(money("0.00", "USD"))).toBe(true);
    expect(isZeroOrNegative(money("-1.00", "USD"))).toBe(true);
    expect(isZeroOrNegative(money("1.00", "USD"))).toBe(false);
  });
});
