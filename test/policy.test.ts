import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../src/mock-backends/policy.js";

const baseInput = { issueType: "return" as const, traceId: "t1" };

describe("evaluate_policy", () => {
  it("returns high confidence for an unambiguous, currently-effective global policy", async () => {
    const result = await evaluatePolicy({
      ...baseInput,
      region: "US",
      sku: "HOME-MUG-01",
      deliveryDate: "2026-07-24",
      asOfDate: "2026-08-05",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.decision).toBe("eligible");
      expect(result.confidence).toBe("high");
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0]?.policyId).toBe("POL-RETURN-GLOBAL");
    }
  });

  it("reports ineligible with medium confidence when outside the return window", async () => {
    const result = await evaluatePolicy({
      ...baseInput,
      region: "US",
      sku: "HOME-MUG-01",
      deliveryDate: "2026-01-01",
      asOfDate: "2026-08-05",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.withinReturnWindow).toBe(false);
      expect(result.decision).toBe("ineligible");
    }
  });

  it("detects a genuine conflict between EU regional policy and SKU hazmat policy", async () => {
    const result = await evaluatePolicy({
      ...baseInput,
      region: "EU",
      sku: "ELECTRONICS-DRONE",
      deliveryDate: "2026-07-30",
      asOfDate: "2026-08-05",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.decision).toBe("undetermined");
      expect(result.confidence).toBe("low");
      expect(result.conflicts.length).toBeGreaterThan(0);
      const citedIds = result.citations.map((c) => c.policyId);
      expect(citedIds).toContain("POL-RETURN-EU");
      expect(citedIds).toContain("POL-DRONE-HAZMAT");
    }
  });

  it("does not fall back to the global policy when a more-specific policy has expired (stale policy)", async () => {
    const result = await evaluatePolicy({
      ...baseInput,
      region: "US",
      sku: "CLEARANCE-ITEM",
      deliveryDate: "2026-07-09",
      asOfDate: "2026-08-05",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.decision).toBe("undetermined");
      expect(result.confidence).toBe("low");
      expect(result.ambiguities.join(" ")).toMatch(/expired/i);
      // the expired policy is still cited as evidence, not silently replaced by the global fallback
      expect(result.citations.some((c) => c.policyId === "POL-CLEARANCE-2024")).toBe(true);
      expect(result.citations.some((c) => c.policyId === "POL-RETURN-GLOBAL")).toBe(false);
    }
  });

  it("every citation carries traceable provenance (policyId, version, effectiveDate, retrievedAt, traceId)", async () => {
    const result = await evaluatePolicy({
      ...baseInput,
      region: "US",
      sku: "HOME-MUG-01",
      deliveryDate: "2026-07-24",
      asOfDate: "2026-08-05",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const citation = result.citations[0]!;
      expect(citation.provenance.sourceType).toBe("policy_document");
      expect(citation.provenance.policyId).toBe(citation.policyId);
      expect(citation.provenance.traceId).toBe("t1");
      expect(citation.provenance.retrievedAt).toBeTruthy();
    }
  });

  it("rejects unsupported issue types", async () => {
    const result = await evaluatePolicy({
      region: "US",
      sku: "HOME-MUG-01",
      issueType: "account_issue" as any,
      deliveryDate: null,
      asOfDate: "2026-08-05",
      traceId: "t1",
    });
    expect(result.success).toBe(false);
  });
});
