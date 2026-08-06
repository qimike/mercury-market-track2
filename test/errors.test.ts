import { describe, it, expect } from "vitest";
import { ok, fail, err, propagate, isRetryable } from "../src/domain/errors.js";

describe("structured error model", () => {
  it("ok() produces a success:true result with data merged in", () => {
    const result = ok({ refunds: [] as string[] });
    expect(result).toEqual({ success: true, refunds: [] });
  });

  it("distinguishes a valid empty result from a failure", () => {
    const empty = ok({ refunds: [] as string[] });
    const failure = fail("DEPENDENCY", "GATEWAY_DOWN", "down", true);
    expect(empty.success).toBe(true);
    expect(failure.success).toBe(false);
  });

  it("defaults isRetryable based on category when not specified", () => {
    expect(err("DEPENDENCY", "X", "msg").isRetryable).toBe(true);
    expect(err("VALIDATION", "X", "msg").isRetryable).toBe(false);
    expect(err("NOT_FOUND", "X", "msg").isRetryable).toBe(false);
    expect(err("TRANSIENT", "X", "msg").isRetryable).toBe(true);
    expect(err("RATE_LIMIT", "X", "msg").isRetryable).toBe(true);
  });

  it("only categories explicitly marked retryable are retried by isRetryable()", () => {
    const retryable = err("TRANSIENT", "T", "transient");
    const notRetryable = err("VALIDATION", "V", "bad input");
    expect(isRetryable(retryable)).toBe(true);
    expect(isRetryable(notRetryable)).toBe(false);
  });

  it("propagate() preserves the original error as `cause`", () => {
    const original = err("DEPENDENCY", "GATEWAY_TIMEOUT", "gateway timed out", true);
    const wrapped = propagate("INTERNAL", "SUBAGENT_FAILED", "subagent failed", original, false);
    expect(wrapped.cause).toBe(original);
    expect(wrapped.cause?.errorCode).toBe("GATEWAY_TIMEOUT");
  });
});
