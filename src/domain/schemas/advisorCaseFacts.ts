/**
 * Advisor case facts (spec section 15 / Pass 1 "fact extraction"). Distinct
 * from a customer's raw statement: every field here is explicitly tagged by
 * provenance kind so a customer claim is never presented as an externally
 * verified fact anywhere downstream (suggestion packet, customer draft,
 * escalation packet).
 */

import { z } from "zod";
import { MoneySchema } from "../schemas.js";

export const PROVENANCE_KIND = ["customer_claim", "verified_fact", "model_interpretation", "unverified_hypothesis"] as const;
export type ProvenanceKind = (typeof PROVENANCE_KIND)[number];

export const StatementSchema = z.object({
  statementId: z.string(),
  kind: z.enum(PROVENANCE_KIND),
  statement: z.string().min(1),
  sourceReference: z.string().nullable(),
});
export type Statement = z.infer<typeof StatementSchema>;

export const ContradictionSchema = z.object({
  contradictionId: z.string(),
  description: z.string().min(1),
  conflictingStatementIds: z.array(z.string()).min(2),
  resolved: z.boolean(),
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

export const AdvisorCaseFactsSchema = z.object({
  schemaVersion: z.literal("1.0"),
  caseId: z.string(),
  sessionId: z.string(),
  customerReference: z.string(),
  identityStatus: z.enum(["unverified", "verified", "failed", "unavailable"]),
  region: z.string(),
  issueIds: z.array(z.string()),
  orderId: z.string().nullable(),
  lineItemIds: z.array(z.string()),
  currency: z.string().length(3),
  requestedAmount: MoneySchema.nullable(),
  eligibleAmount: MoneySchema.nullable(),
  orderTotal: MoneySchema.nullable(),
  importantDates: z.object({
    orderDate: z.string().nullable(),
    deliveryDate: z.string().nullable(),
    requestDate: z.string(),
  }),
  statements: z.array(StatementSchema),
  unresolvedContradictions: z.array(ContradictionSchema),
  missingFacts: z.array(z.string()),
  policyReferences: z.array(z.string()),
  provenanceReferences: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  lastUpdatedAt: z.string(),
});
export type AdvisorCaseFacts = z.infer<typeof AdvisorCaseFactsSchema>;

/** True only when every statement referenced by `statementIds` is tagged verified_fact — used to block claim-as-fact leaks. */
export function allVerified(facts: AdvisorCaseFacts, statementIds: string[]): boolean {
  const byId = new Map(facts.statements.map((s) => [s.statementId, s]));
  return statementIds.every((id) => byId.get(id)?.kind === "verified_fact");
}
