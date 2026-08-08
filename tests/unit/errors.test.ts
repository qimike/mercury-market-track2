import { describe, expect, it } from "vitest";
import { ok, fail, err, propagate, isRetryable, DomainError } from "../../src/domain/errors.js";

describe("structured tool error model", () => {
  it("ok() spreads data with success:true", () => {
    const result = ok({ customerId: "cust_001" });
    expect(result).toEqual({ success: true, customerId: "cust_001" });
  });

  it("fail() builds a structured failure with a default retryability by category", () => {
    const result = fail("NOT_FOUND", "CUSTOMER_NOT_FOUND", "No such customer.");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.isRetryable).toBe(false); // NOT_FOUND is not in the retryable set
    }
  });

  it("TRANSIENT/DEPENDENCY/RATE_LIMIT default to retryable", () => {
    expect(err("TRANSIENT", "X", "x").isRetryable).toBe(true);
    expect(err("DEPENDENCY", "X", "x").isRetryable).toBe(true);
    expect(err("RATE_LIMIT", "X", "x").isRetryable).toBe(true);
    expect(err("VALIDATION", "X", "x").isRetryable).toBe(false);
  });

  it("propagate() preserves the original error as cause", () => {
    const original = err("DEPENDENCY", "GATEWAY_DOWN", "downstream failed", true);
    const wrapped = propagate("INTERNAL", "REFUND_FAILED", "refund failed", original);
    expect(wrapped.cause).toBe(original);
    expect(isRetryable(wrapped)).toBe(true); // inherited from cause
  });

  it("DomainError carries the structured ToolError", () => {
    const toolError = err("VALIDATION", "BAD_INPUT", "bad input");
    const thrown = new DomainError(toolError);
    expect(thrown.toolError).toBe(toolError);
    expect(thrown.message).toBe("bad input");
  });
});
