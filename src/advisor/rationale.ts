/**
 * Derives the internal Rationale (spec section 17) deterministically from an
 * already-validated SuggestionPacket, rather than asking the model for a
 * second free-form artifact. This keeps the rationale strictly a projection
 * of fields that already passed schema + semantic validation — it can never
 * contain anything the packet doesn't already substantiate, and it never
 * touches model reasoning tokens (no chain-of-thought is stored anywhere).
 */

import { buildRationale, type Rationale } from "../domain/schemas/rationale.js";
import type { SuggestionPacket } from "../domain/schemas/suggestionPacket.js";

export function deriveRationale(packet: SuggestionPacket): Rationale {
  return buildRationale({
    suggestionId: packet.suggestionId,
    recommendationSummary: packet.integratedRecommendation.internalSummary,
    supportingEvidence: packet.issues.flatMap((i) => i.verifiedFactReferences),
    limitingEvidence: packet.issues.flatMap((i) => i.missingInformation),
    applicablePolicies: packet.policyCitations.map((c) => `${c.policyId}@v${c.version}`),
    unresolvedAmbiguity: packet.integratedRecommendation.unresolvedQuestions,
    alternativesConsidered: packet.integratedRecommendation.conflictsDetected.map((conflict) => ({
      alternative: conflict,
      reasonNotRecommended: "Rejected during cross-issue integration review as a conflicting or duplicate remedy.",
    })),
    confidence: packet.overallConfidence,
    informationNeededToImproveConfidence: packet.issues.flatMap((i) => i.missingInformation),
    provenanceReferences: packet.dataProvenance.map((p) => p.sourceReference),
  });
}
