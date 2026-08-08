/**
 * Suggestion packet — the versioned, hash-stamped, schema-validated output of
 * the advisor's multi-pass review (src/advisor/passes/*). This is the ONLY
 * object a human_support_agent may approve, edit, or reject; approval is
 * bound to `suggestionHash`/`actionHash` (see src/approvals/), never to a
 * free-text description of what the advisor proposed.
 *
 * Structure follows the spec's suggestion-packet schema (section 16)
 * verbatim, field for field.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { MoneySchema, PolicyCitationSchema } from "../schemas.js";
import { canonicalStringify } from "./canonicalJson.js";

export const ISSUE_TYPES = [
  "return",
  "billing_dispute",
  "duplicate_charge",
  "damaged_item",
  "missing_item",
  "delivery_issue",
  "account_issue",
  "order_question",
  "other",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ACTION_TYPES = [
  "request_information",
  "provide_explanation",
  "initiate_return",
  "propose_refund",
  "escalate",
  "account_support",
  "other",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const DECISION_STATES = ["eligible", "ineligible", "partially_eligible", "ambiguous", "unavailable"] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

export const EXECUTION_STATUSES = [
  "not_requested",
  "awaiting_approval",
  "approved",
  "rejected",
  "executed",
  "failed",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const HUMAN_DECISION_STATUSES = [
  "pending",
  "approved",
  "approved_with_changes",
  "rejected",
  "revision_requested",
] as const;
export type HumanDecisionStatus = (typeof HUMAN_DECISION_STATUSES)[number];

export const IdentityStatusSchema = z.enum(["unverified", "verified", "failed", "unavailable"]);

export const IssueAssessmentSchema = z.object({
  issueId: z.string(),
  issueType: z.enum(ISSUE_TYPES),
  analysisSummary: z.string().min(1),
  decision: z.enum(DECISION_STATES),
  confidence: z.number().min(0).max(1),
  customerClaimReferences: z.array(z.string()),
  verifiedFactReferences: z.array(z.string()),
  policyCitationReferences: z.array(z.string()),
  missingInformation: z.array(z.string()),
  risks: z.array(z.string()),
});
export type IssueAssessment = z.infer<typeof IssueAssessmentSchema>;

export const ProposedActionSchema = z.object({
  actionId: z.string(),
  actionVersion: z.number().int().positive(),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  actionType: z.enum(ACTION_TYPES),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  requiresHumanApproval: z.literal(true),
  executionStatus: z.enum(EXECUTION_STATUSES),
  preconditions: z.array(z.string()),
  blockingIssues: z.array(z.string()),
  idempotencyKey: z.string().nullable(),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const PolicyCitationEntrySchema = z.object({
  policyId: z.string(),
  title: z.string(),
  version: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  sourceReference: z.string(),
  relevantClauses: z.array(z.string()),
  retrievedAt: z.string(),
});
export type PolicyCitationEntry = z.infer<typeof PolicyCitationEntrySchema>;

export const DataProvenanceEntrySchema = z.object({
  sourceType: z.enum(["crm", "oms", "payments", "policy", "customer", "ticketing", "agent"]),
  sourceReference: z.string(),
  retrievedAt: z.string(),
  toolCallId: z.string().nullable(),
  correlationId: z.string().nullable(),
});
export type DataProvenanceEntry = z.infer<typeof DataProvenanceEntrySchema>;

export const ReviewFindingRefSchema = z.string();

export const SuggestionPacketSchema = z.object({
  schemaVersion: z.literal("1.0"),
  suggestionId: z.string(),
  suggestionVersion: z.number().int().positive(),
  suggestionHash: z.string().regex(/^[a-f0-9]{64}$/),
  caseId: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
  advisorMode: z.literal("human_in_the_loop"),
  customerIntent: z.string(),
  caseSummary: z.string(),
  identityStatus: IdentityStatusSchema,
  issues: z.array(IssueAssessmentSchema),
  integratedRecommendation: z.object({
    recommendedOutcome: z.string(),
    customerFacingDraft: z.string(),
    internalSummary: z.string(),
    conflictsDetected: z.array(z.string()),
    unresolvedQuestions: z.array(z.string()),
  }),
  proposedActions: z.array(ProposedActionSchema),
  policyCitations: z.array(PolicyCitationEntrySchema),
  dataProvenance: z.array(DataProvenanceEntrySchema),
  review: z.object({
    status: z.enum(["pass", "pass_with_notes", "blocked"]),
    blockingFindings: z.array(ReviewFindingRefSchema),
    nonBlockingFindings: z.array(ReviewFindingRefSchema),
    reviewedAt: z.string(),
  }),
  humanDecision: z.object({
    status: z.enum(HUMAN_DECISION_STATUSES),
    approvedSuggestionHash: z.string().nullable(),
    approvedActionHashes: z.array(z.string()),
    reviewerReference: z.string().nullable(),
    decidedAt: z.string().nullable(),
    corrections: z.array(z.string()),
    comment: z.string().nullable(),
  }),
  overallConfidence: z.number().min(0).max(1),
  humanReviewRequired: z.literal(true),
});
export type SuggestionPacket = z.infer<typeof SuggestionPacketSchema>;

function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

interface HashableAction {
  actionId: string;
  actionVersion: number;
  actionType: ActionType;
  description: string;
  parameters: Record<string, unknown>;
  idempotencyKey: string | null;
}

function hashAction(action: HashableAction): string {
  return stableHash({
    actionId: action.actionId,
    actionVersion: action.actionVersion,
    actionType: action.actionType,
    description: action.description,
    parameters: action.parameters,
    idempotencyKey: action.idempotencyKey,
  });
}

export interface ProposedActionDraft {
  actionId: string;
  actionType: ActionType;
  description: string;
  parameters: Record<string, unknown>;
  executionStatus: ExecutionStatus;
  preconditions: string[];
  blockingIssues: string[];
  idempotencyKey: string | null;
  /** Defaults to 1; incremented by src/approvals when a human materially edits the action. */
  actionVersion?: number;
}

export interface SuggestionPacketDraft {
  caseId: string;
  sessionId: string;
  customerIntent: string;
  caseSummary: string;
  identityStatus: z.infer<typeof IdentityStatusSchema>;
  issues: IssueAssessment[];
  integratedRecommendation: SuggestionPacket["integratedRecommendation"];
  proposedActions: ProposedActionDraft[];
  policyCitations: PolicyCitationEntry[];
  dataProvenance: DataProvenanceEntry[];
  review: SuggestionPacket["review"];
  overallConfidence: number;
  suggestionId?: string;
  suggestionVersion?: number;
  createdAt?: string;
}

/** Builds a schema-valid, hash-stamped SuggestionPacket from a draft (see src/advisor/passes/packet.ts). */
export function buildSuggestionPacket(draft: SuggestionPacketDraft): SuggestionPacket {
  const createdAt = draft.createdAt ?? new Date().toISOString();
  const suggestionVersion = draft.suggestionVersion ?? 1;
  const suggestionId = draft.suggestionId ?? `suggestion_${stableHash({ caseId: draft.caseId, sessionId: draft.sessionId, createdAt }).slice(0, 16)}`;

  const proposedActions: ProposedAction[] = draft.proposedActions.map((action) => {
    const actionVersion = action.actionVersion ?? 1;
    const actionHash = hashAction({ ...action, actionVersion });
    return {
      actionId: action.actionId,
      actionVersion,
      actionHash,
      actionType: action.actionType,
      description: action.description,
      parameters: action.parameters,
      requiresHumanApproval: true,
      executionStatus: action.executionStatus,
      preconditions: action.preconditions,
      blockingIssues: action.blockingIssues,
      idempotencyKey: action.idempotencyKey,
    };
  });

  const hashableContent = {
    schemaVersion: "1.0",
    suggestionId,
    suggestionVersion,
    caseId: draft.caseId,
    sessionId: draft.sessionId,
    customerIntent: draft.customerIntent,
    caseSummary: draft.caseSummary,
    identityStatus: draft.identityStatus,
    issues: draft.issues,
    integratedRecommendation: draft.integratedRecommendation,
    proposedActions: proposedActions.map((a) => ({ actionId: a.actionId, actionVersion: a.actionVersion, actionHash: a.actionHash })),
    policyCitations: draft.policyCitations,
    overallConfidence: draft.overallConfidence,
  };
  const suggestionHash = stableHash(hashableContent);

  return {
    schemaVersion: "1.0",
    suggestionId,
    suggestionVersion,
    suggestionHash,
    caseId: draft.caseId,
    sessionId: draft.sessionId,
    createdAt,
    advisorMode: "human_in_the_loop",
    customerIntent: draft.customerIntent,
    caseSummary: draft.caseSummary,
    identityStatus: draft.identityStatus,
    issues: draft.issues,
    integratedRecommendation: draft.integratedRecommendation,
    proposedActions,
    policyCitations: draft.policyCitations,
    dataProvenance: draft.dataProvenance,
    review: draft.review,
    humanDecision: {
      status: "pending",
      approvedSuggestionHash: null,
      approvedActionHashes: [],
      reviewerReference: null,
      decidedAt: null,
      corrections: [],
      comment: null,
    },
    overallConfidence: draft.overallConfidence,
    humanReviewRequired: true,
  };
}

/** Recomputes an action's hash after a human edit — used to detect/produce a material change (src/approvals/decide.ts). */
export function recomputeActionHash(action: Pick<ProposedAction, "actionId" | "actionVersion" | "actionType" | "description" | "parameters" | "idempotencyKey">): string {
  return hashAction(action);
}

export { PolicyCitationSchema };
