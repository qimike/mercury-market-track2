/**
 * Structured-output schemas enforced via Claude tool_use (see src/agent/loop.ts
 * and src/agent/validation.ts) — never via "please respond in JSON" prompting.
 * Every schema here is registered as a tool's input_schema so Claude MUST emit
 * a matching object to advance the conversation; validation.ts re-checks
 * semantic invariants the JSON Schema shape alone can't express (cross-field
 * sums, currency matches, etc.) and drives the bounded correction retry loop.
 */

import { z } from "zod";
import { ERROR_CATEGORIES } from "./errors.js";

/** Mirrors ToolError (errors.ts) as a zod shape so MCP tool output schemas can describe it. */
export const ToolErrorSchema = z.object({
  errorCode: z.string(),
  errorCategory: z.enum(ERROR_CATEGORIES),
  message: z.string(),
  isRetryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Every MCP tool's structuredContent follows this envelope: `success` plus
 * either the tool's own data fields or a populated `error`. Expressed as a
 * loose object (rather than a strict discriminated union) because the MCP
 * SDK's registerTool output schema is a flat ZodRawShape; the authoritative
 * success/failure branching happens in domain/errors.ts's ToolResult<T> at
 * the TypeScript layer, not by relying on this schema for correctness.
 */
export function toolResultShape<Shape extends z.ZodRawShape>(dataShape: Shape) {
  return {
    success: z.boolean(),
    error: ToolErrorSchema.optional(),
    ...dataShape,
  };
}

/** Decimal-string money, never a float, always paired with an explicit currency. */
export const MoneySchema = z.object({
  amount: z.string().regex(/^-?\d+(\.\d+)?$/, "must be a decimal string, e.g. \"42.50\""),
  currency: z.string().length(3),
});
export type MoneyInput = z.infer<typeof MoneySchema>;

export const ProvenanceSchema = z.object({
  sourceType: z.enum(["mcp_tool", "mcp_resource", "policy_document", "human_input"]),
  sourceId: z.string(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  resourceUri: z.string().optional(),
  policyId: z.string().optional(),
  policyVersion: z.string().optional(),
  effectiveDate: z.string().optional(),
  retrievedAt: z.string(),
  traceId: z.string(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const PolicyCitationSchema = z.object({
  policyId: z.string(),
  version: z.string(),
  title: z.string(),
  region: z.string(),
  skuScope: z.string(),
  effectiveDate: z.string(),
  expirationDate: z.string().nullable(),
  excerpt: z.string(),
  provenance: ProvenanceSchema,
});
export type PolicyCitation = z.infer<typeof PolicyCitationSchema>;

export const ConfidenceLevelSchema = z.enum(["high", "medium", "low"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const LineItemSchema = z.object({
  sku: z.string(),
  description: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: MoneySchema,
  lineTotal: MoneySchema,
});
export type LineItem = z.infer<typeof LineItemSchema>;

/**
 * Case Facts — the persisted, structured record of what is known about a case.
 * This is the object carried across turns/sessions (see src/agent/context.ts)
 * instead of raw tool payloads.
 */
export const CaseFactsSchema = z.object({
  caseId: z.string(),
  customerId: z.string(),
  identityStatus: z.enum(["unverified", "verified", "locked"]),
  issueType: z.enum([
    "return",
    "billing_dispute",
    "account_issue",
    "refund_request",
    "order_issue",
    "policy_question",
  ]),
  region: z.string(),
  currency: z.string().length(3),
  orderId: z.string().nullable(),
  relevantDates: z.object({
    orderDate: z.string().nullable(),
    deliveryDate: z.string().nullable(),
    requestDate: z.string(),
  }),
  requestedAmount: MoneySchema.nullable(),
  lineItems: z.array(LineItemSchema),
  reason: z.string(),
  knownAmbiguities: z.array(z.string()),
});
export type CaseFacts = z.infer<typeof CaseFactsSchema>;

export const RiskFlagSchema = z.enum([
  "high_value",
  "account_locked",
  "policy_conflict",
  "stale_policy",
  "missing_provenance",
  "currency_mismatch",
  "duplicate_refund_attempt",
  "refund_exceeds_balance",
  "identity_unverified",
]);

export const ToolFailureRecordSchema = z.object({
  toolName: z.string(),
  errorCode: z.string(),
  errorCategory: z.string(),
  attempts: z.number().int().nonnegative(),
  finalOutcome: z.enum(["succeeded_after_retry", "exhausted_retries", "non_retryable"]),
});

/**
 * Escalation Packet — the auditor-ready handoff object produced whenever the
 * coordinator routes a case to a human. Every consequential claim inside must
 * trace back to a Provenance entry; nothing may be asserted without one.
 */
export const EscalationPacketSchema = z.object({
  caseId: z.string(),
  traceId: z.string(),
  customerSummary: z.string().min(1),
  internalSummary: z.string().min(1),
  identityState: z.enum(["unverified", "verified", "locked"]),
  orderFacts: z.record(z.string(), z.unknown()).nullable(),
  paymentFacts: z.record(z.string(), z.unknown()).nullable(),
  requestedAction: z.enum([
    "refund",
    "return",
    "billing_correction",
    "account_unlock",
    "information_only",
  ]),
  requestedAmount: MoneySchema.nullable(),
  eligibleAmount: MoneySchema.nullable(),
  policyDecision: z.enum(["eligible", "ineligible", "partially_eligible", "undetermined"]),
  policyCitations: z.array(PolicyCitationSchema),
  policyVersion: z.string().nullable(),
  policyEffectiveDate: z.string().nullable(),
  confidence: ConfidenceLevelSchema,
  ambiguities: z.array(z.string()),
  riskFlags: z.array(RiskFlagSchema),
  actionsAlreadyTaken: z.array(z.string()),
  toolFailures: z.array(ToolFailureRecordSchema),
  escalationReason: z.string().min(1),
  recommendedHumanAction: z.string().min(1),
  provenance: z.array(ProvenanceSchema),
});
export type EscalationPacket = z.infer<typeof EscalationPacketSchema>;

export const PolicyEvaluationResultSchema = z.object({
  decision: z.enum(["eligible", "ineligible", "partially_eligible", "undetermined"]),
  eligibleAmount: MoneySchema.nullable(),
  confidence: ConfidenceLevelSchema,
  citations: z.array(PolicyCitationSchema),
  conflicts: z.array(
    z.object({
      policyA: z.string(),
      policyB: z.string(),
      description: z.string(),
    })
  ),
  ambiguities: z.array(z.string()),
});
export type PolicyEvaluationResult = z.infer<typeof PolicyEvaluationResultSchema>;

export const RefundDecisionSchema = z.object({
  routing: z.enum(["autonomous", "escalate"]),
  reason: z.string(),
  amount: MoneySchema,
  requiresIdempotencyKey: z.boolean(),
});
export type RefundDecision = z.infer<typeof RefundDecisionSchema>;

/**
 * Resolution — the structured, schema-enforced output for a case the
 * coordinator resolves autonomously (never emitted via free text). Every
 * amount/citation/transaction id here is cross-checked by
 * src/agent/validation.ts against what was actually retrieved this case
 * before the loop accepts it as terminal.
 */
export const ResolutionSchema = z.object({
  caseId: z.string(),
  outcome: z.literal("resolved_autonomously"),
  customerSummary: z.string().min(1),
  internalSummary: z.string().min(1),
  refundTransactionId: z.string().nullable(),
  refundAmount: MoneySchema.nullable(),
  policyCitations: z.array(PolicyCitationSchema),
  actionsTaken: z.array(z.string()),
  provenance: z.array(ProvenanceSchema),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

/**
 * Subagent finding schemas. Each subagent's nested loop (src/agent/subagentLoop.ts)
 * terminates by calling its own `submit_*_finding` tool, enforced via the same
 * tool_use + JSON Schema mechanism as the coordinator's resolve_case/escalate_to_human.
 */
export const IdentityFindingSchema = z.object({
  caseId: z.string(),
  customerId: z.string(),
  identityStatus: z.enum(["unverified", "verified", "locked"]),
  verified: z.boolean(),
  notes: z.string(),
});
export type IdentityFinding = z.infer<typeof IdentityFindingSchema>;

export const OrderFindingSchema = z.object({
  caseId: z.string(),
  orderId: z.string().nullable(),
  orderExists: z.boolean(),
  customerMatches: z.boolean(),
  status: z.string().nullable(),
  currency: z.string().nullable(),
  region: z.string().nullable(),
  deliveryDate: z.string().nullable(),
  lineItems: z.array(LineItemSchema),
  amountPaid: MoneySchema.nullable(),
  notes: z.string(),
});
export type OrderFinding = z.infer<typeof OrderFindingSchema>;

export const PolicyFindingSchema = z.object({
  caseId: z.string(),
  decision: z.enum(["eligible", "ineligible", "partially_eligible", "undetermined"]),
  confidence: ConfidenceLevelSchema,
  citations: z.array(PolicyCitationSchema),
  conflicts: z.array(z.object({ policyA: z.string(), policyB: z.string(), description: z.string() })),
  ambiguities: z.array(z.string()),
  notes: z.string(),
});
export type PolicyFinding = z.infer<typeof PolicyFindingSchema>;

export const RefundFindingSchema = z.object({
  caseId: z.string(),
  routing: z.enum(["autonomous", "escalate", "not_applicable"]),
  refundTransactionId: z.string().nullable(),
  amount: MoneySchema.nullable(),
  reason: z.string(),
  blockedReason: z.string().nullable(),
});
export type RefundFinding = z.infer<typeof RefundFindingSchema>;
