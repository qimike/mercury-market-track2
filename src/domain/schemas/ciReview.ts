/**
 * CI review — the machine-readable output of governance checks against
 * policy/prompt/tool-description/schema/permission changes (spec section 33).
 * Deterministic checks (src/governance/deterministicChecks.ts) and the
 * model-assisted pass (src/governance/ciReview.ts) both emit this shape;
 * malformed output must fail the gate closed, never pass silently (section
 * 34 / 37) — see src/governance/ciReview.ts's `parseCiReview`.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalStringify } from "./canonicalJson.js";

export const SEVERITIES = ["blocker", "high", "medium", "low", "informational"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Severities that fail the gate by default. Configurable — see src/governance/deterministicChecks.ts's `GATE_CONFIG`. */
export const DEFAULT_BLOCKING_SEVERITIES: Severity[] = ["blocker", "high"];

export const CiFindingSchema = z.object({
  findingId: z.string().min(1),
  severity: z.enum(SEVERITIES),
  category: z.string().min(1),
  path: z.string(),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  summary: z.string().min(1),
  evidence: z.string().min(1),
  ruleReference: z.string().min(1),
  suggestedFix: z.string().min(1),
  confidence: z.number().min(0).max(1),
  fingerprint: z.string().min(1),
});
export type CiFinding = z.infer<typeof CiFindingSchema>;

export const SuppressedFindingSchema = z.object({
  findingId: z.string(),
  fingerprint: z.string(),
  reason: z.string().min(1),
  reviewerOrConfigReference: z.string().min(1),
  suppressedAt: z.string(),
});
export type SuppressedFinding = z.infer<typeof SuppressedFindingSchema>;

export const CiReviewSchema = z.object({
  schemaVersion: z.literal("1.0"),
  status: z.enum(["pass", "pass_with_notes", "fail", "error"]),
  reviewType: z.enum(["policy", "prompt", "tool_description", "schema", "permission", "integrated"]),
  findings: z.array(CiFindingSchema),
  suppressedFindings: z.array(SuppressedFindingSchema),
  reviewedFiles: z.array(z.string()),
  reviewMetadata: z.object({
    commit: z.string().nullable(),
    baseCommit: z.string().nullable(),
    generatedAt: z.string(),
  }),
});
export type CiReview = z.infer<typeof CiReviewSchema>;

/**
 * Fingerprints are built from stable, semantic properties — never raw line
 * numbers alone — so a finding survives an unrelated reformat and reruns
 * dedupe correctly (spec section 35).
 */
export function buildFingerprint(input: {
  ruleReference: string;
  normalizedPath: string;
  category: string;
  normalizedEvidence: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalStringify({
        ruleReference: input.ruleReference,
        normalizedPath: input.normalizedPath,
        category: input.category,
        normalizedEvidence: input.normalizedEvidence.trim().replace(/\s+/g, " ").toLowerCase(),
      })
    )
    .digest("hex")
    .slice(0, 32);
}

export function parseCiReview(raw: unknown): { ok: true; value: CiReview } | { ok: false; error: string } {
  const parsed = CiReviewSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, value: parsed.data };
}
