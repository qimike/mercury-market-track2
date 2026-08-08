/**
 * Rationale — a separate, stable schema for the advisor's internal decision
 * summary (spec section 17). Kept distinct from `SuggestionPacket.
 * integratedRecommendation` because a rationale is explicitly allowed to
 * contain internal-only reasoning (alternatives considered, why they were
 * rejected) that must never leak into `customerFacingDraft`. This is a
 * concise, operational summary — never private chain-of-thought (no raw
 * model reasoning tokens are ever written here or anywhere else).
 */

import { z } from "zod";

export const RationaleSchema = z.object({
  rationaleId: z.string(),
  suggestionId: z.string(),
  recommendationSummary: z.string().min(1),
  supportingEvidence: z.array(z.string()),
  limitingEvidence: z.array(z.string()),
  applicablePolicies: z.array(z.string()),
  unresolvedAmbiguity: z.array(z.string()),
  alternativesConsidered: z.array(
    z.object({
      alternative: z.string(),
      reasonNotRecommended: z.string(),
    })
  ),
  confidence: z.number().min(0).max(1),
  informationNeededToImproveConfidence: z.array(z.string()),
  provenanceReferences: z.array(z.string()),
  createdAt: z.string(),
});
export type Rationale = z.infer<typeof RationaleSchema>;

export function buildRationale(input: Omit<Rationale, "createdAt" | "rationaleId"> & { rationaleId?: string; createdAt?: string }): Rationale {
  return {
    rationaleId: input.rationaleId ?? `rationale_${input.suggestionId}`,
    createdAt: input.createdAt ?? new Date().toISOString(),
    suggestionId: input.suggestionId,
    recommendationSummary: input.recommendationSummary,
    supportingEvidence: input.supportingEvidence,
    limitingEvidence: input.limitingEvidence,
    applicablePolicies: input.applicablePolicies,
    unresolvedAmbiguity: input.unresolvedAmbiguity,
    alternativesConsidered: input.alternativesConsidered,
    confidence: input.confidence,
    informationNeededToImproveConfidence: input.informationNeededToImproveConfidence,
    provenanceReferences: input.provenanceReferences,
  };
}
