import { describe, expect, it } from "vitest";
import { buildFingerprint, parseCiReview, CiReviewSchema } from "../../src/domain/schemas/ciReview.js";

describe("CI review schema", () => {
  it("builds a stable fingerprint independent of raw line numbers", () => {
    const a = buildFingerprint({ ruleReference: "rule-1", normalizedPath: "policies/x.md", category: "policy", normalizedEvidence: "Some   evidence\ntext" });
    const b = buildFingerprint({ ruleReference: "rule-1", normalizedPath: "policies/x.md", category: "policy", normalizedEvidence: "some evidence text" });
    expect(a).toBe(b); // whitespace/case normalized
  });

  it("produces a different fingerprint for a different rule", () => {
    const a = buildFingerprint({ ruleReference: "rule-1", normalizedPath: "policies/x.md", category: "policy", normalizedEvidence: "evidence" });
    const b = buildFingerprint({ ruleReference: "rule-2", normalizedPath: "policies/x.md", category: "policy", normalizedEvidence: "evidence" });
    expect(a).not.toBe(b);
  });

  it("parseCiReview accepts a well-formed review", () => {
    const review = {
      schemaVersion: "1.0",
      status: "pass",
      reviewType: "policy",
      findings: [],
      suppressedFindings: [],
      reviewedFiles: [],
      reviewMetadata: { commit: null, baseCommit: null, generatedAt: "2026-08-07T00:00:00.000Z" },
    };
    const result = parseCiReview(review);
    expect(result.ok).toBe(true);
  });

  it("parseCiReview fails safe (does not silently pass) on malformed JSON shape", () => {
    const malformed = { status: "pass" }; // missing required fields
    const result = parseCiReview(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it("rejects an out-of-enum severity", () => {
    const parsed = CiReviewSchema.safeParse({
      schemaVersion: "1.0",
      status: "pass",
      reviewType: "policy",
      findings: [
        {
          findingId: "f1",
          severity: "catastrophic", // not a valid severity
          category: "x",
          path: "x",
          lineStart: 0,
          lineEnd: 0,
          summary: "x",
          evidence: "x",
          ruleReference: "x",
          suggestedFix: "x",
          confidence: 1,
          fingerprint: "x",
        },
      ],
      suppressedFindings: [],
      reviewedFiles: [],
      reviewMetadata: { commit: null, baseCommit: null, generatedAt: "2026-08-07T00:00:00.000Z" },
    });
    expect(parsed.success).toBe(false);
  });
});
