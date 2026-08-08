/**
 * Resolution-proposal specialist output (spec section 7.5 "Resolution
 * proposal generation"). Deliberately NOT a transaction record — this is the
 * Track 2 replacement for Track 1's RefundFindingSchema (which reported an
 * already-executed refund). The resolution specialist may only ever produce
 * a proposed action for a human to review; it has no tool access to
 * `process_refund`/`create_return` at all (see src/agent/subagents/resolution.ts).
 */

import { z } from "zod";
import { MoneySchema, ConfidenceLevelSchema } from "../schemas.js";
import { ACTION_TYPES } from "./suggestionPacket.js";

export const ProposalFindingSchema = z.object({
  caseId: z.string(),
  issueId: z.string(),
  proposedActionType: z.enum(ACTION_TYPES),
  description: z.string().min(1),
  proposedAmount: MoneySchema.nullable(),
  reason: z.string().min(1),
  preconditions: z.array(z.string()),
  blockingIssues: z.array(z.string()),
  confidence: ConfidenceLevelSchema,
});
export type ProposalFinding = z.infer<typeof ProposalFindingSchema>;
