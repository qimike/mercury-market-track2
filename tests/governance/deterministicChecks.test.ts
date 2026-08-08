import { describe, expect, it } from "vitest";
import { checkPolicyCatalog, checkPermissionConfiguration, checkApprovalHashes, runAllDeterministicChecks } from "../../src/governance/deterministicChecks.js";
import { recordApproval, _resetApprovalStoreMockState } from "../../src/approvals/store.js";

describe("deterministic governance checks", () => {
  it("the real seeded policy catalog has no duplicate/missing-date/broken-reference findings", () => {
    // This is the harmless-change baseline (spec Example I): running checks against
    // the actual, unmodified policy catalog must not produce any blocking findings.
    const findings = checkPolicyCatalog();
    const blocking = findings.filter((f) => f.severity === "blocker");
    expect(blocking).toEqual([]);
  });

  it("permission configuration has no overlap between advisor-allowed and human-execution-only tools", () => {
    expect(checkPermissionConfiguration()).toEqual([]);
  });

  it("flags a malformed approval hash", () => {
    recordApproval({
      suggestionId: "s1", suggestionVersion: 1, suggestionHash: "not-a-real-hash",
      actionId: "a1", actionVersion: 1, actionHash: "b".repeat(64),
      status: "approved", reviewerReference: "human_1", decidedAt: "2026-08-07T00:00:00.000Z",
      forkedFromSessionId: null, executedAt: null, executedTransactionRef: null,
    });
    const findings = checkApprovalHashes();
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.severity).toBe("blocker");
    _resetApprovalStoreMockState();
  });

  it("produces stable fingerprints across repeated runs (no duplicate reporting on rerun)", () => {
    const run1 = runAllDeterministicChecks();
    const run2 = runAllDeterministicChecks();
    expect(run1.map((f) => f.fingerprint)).toEqual(run2.map((f) => f.fingerprint));
  });
});
