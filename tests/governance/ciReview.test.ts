import { describe, expect, it } from "vitest";
import { compareAgainstPrior, runGovernanceReview, isClaudeCliAvailable } from "../../src/governance/ciReview.js";
import type { CiFinding } from "../../src/domain/schemas/ciReview.js";

function finding(overrides: Partial<CiFinding> = {}): CiFinding {
  return {
    findingId: "f1", severity: "high", category: "test", path: "x.ts", lineStart: 0, lineEnd: 0,
    summary: "x", evidence: "x", ruleReference: "r1", suggestedFix: "x", confidence: 1, fingerprint: "fp1",
    ...overrides,
  };
}

describe("governance CI review orchestration", () => {
  it("classifies fresh vs still-active vs fixed findings by fingerprint", () => {
    const prior = [finding({ fingerprint: "fp1" }), finding({ fingerprint: "fp2" })];
    const current = [finding({ fingerprint: "fp1" }), finding({ fingerprint: "fp3" })];
    const comparison = compareAgainstPrior(current, prior);
    expect(comparison.fresh.map((f) => f.fingerprint)).toEqual(["fp3"]);
    expect(comparison.stillActive.map((f) => f.fingerprint)).toEqual(["fp1"]);
    expect(comparison.fixed.map((f) => f.fingerprint)).toEqual(["fp2"]);
  });

  it("reports a previously-fixed finding as fresh again if it returns", () => {
    const prior = [finding({ fingerprint: "fp1" })];
    const currentAfterFix = [] as CiFinding[];
    const fixedComparison = compareAgainstPrior(currentAfterFix, prior);
    expect(fixedComparison.fixed.map((f) => f.fingerprint)).toEqual(["fp1"]);

    // Same finding reappears in a later run — it must be reported (fresh), not silently suppressed.
    const currentAfterRegression = [finding({ fingerprint: "fp1" })];
    const regressionComparison = compareAgainstPrior(currentAfterRegression, currentAfterFix);
    expect(regressionComparison.fresh.map((f) => f.fingerprint)).toEqual(["fp1"]);
  });

  it("gates status on the real policy catalog running deterministic-only (no model prompt supplied)", async () => {
    const { review, modelAssisted } = await runGovernanceReview({ reviewType: "integrated", reviewedFiles: ["policies/"] });
    expect(["pass", "pass_with_notes", "fail"]).toContain(review.status);
    expect(modelAssisted).toBe("skipped_unavailable");
  });

  it("documents whether the claude CLI is available in this environment (informational, not a pass/fail gate)", async () => {
    const available = await isClaudeCliAvailable();
    expect(typeof available).toBe("boolean");
  });
});
