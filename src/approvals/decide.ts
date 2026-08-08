/**
 * Human decision workflow (spec sections 10/20/Pass 6). Every function here
 * operates on the packet in src/advisor/packetStore.ts and the approval
 * record in src/approvals/store.ts — never on a copy a caller might diverge
 * from. Editing a proposed action's material fields always bumps its
 * actionVersion/actionHash (and, because the suggestion's own hash is
 * computed over its actions' hashes, the suggestionHash too) and marks it
 * unapproved again — there is no path that lets a stale hash still execute
 * (see src/mcp/authorization.ts's hash-match checks).
 */

import { getSuggestionPacket, replaceSuggestionPacket } from "../advisor/packetStore.js";
import { recomputeActionHash, type SuggestionPacket, type ProposedAction } from "../domain/schemas/suggestionPacket.js";
import { canonicalStringify } from "../domain/schemas/canonicalJson.js";
import { recordApproval, type ApprovalRecord } from "./store.js";

export type DecideResult = { ok: true; packet: SuggestionPacket } | { ok: false; error: string };

/** Material fields per spec section 20: actionType + everything inside parameters (customer ref, order id, line items, amount, currency, reason, remedy, policy ref, execution target all live in `parameters` in this model). */
function actionContentEqual(a: ProposedAction, actionType: ProposedAction["actionType"], parameters: Record<string, unknown>): boolean {
  return a.actionType === actionType && canonicalStringify(a.parameters) === canonicalStringify(parameters);
}

function findAction(packet: SuggestionPacket, actionId: string): ProposedAction | undefined {
  return packet.proposedActions.find((a) => a.actionId === actionId);
}

function withUpdatedAction(packet: SuggestionPacket, actionId: string, updater: (a: ProposedAction) => ProposedAction): SuggestionPacket {
  return { ...packet, proposedActions: packet.proposedActions.map((a) => (a.actionId === actionId ? updater(a) : a)) };
}

export function approveAction(
  suggestionId: string,
  actionId: string,
  reviewerId: string,
  comment: string | null = null,
  /** Non-null when this approval is being recorded from within a forked investigation session — such an approval can never authorize execution (see src/mcp/authorization.ts's FORKED_APPROVAL_NOT_EXECUTABLE check). */
  forkedFromSessionId: string | null = null
): DecideResult {
  const packet = getSuggestionPacket(suggestionId);
  if (!packet) return { ok: false, error: `No suggestion packet found with id "${suggestionId}".` };
  const action = findAction(packet, actionId);
  if (!action) return { ok: false, error: `No proposed action "${actionId}" on suggestion "${suggestionId}".` };

  const decidedAt = new Date().toISOString();
  const updated: SuggestionPacket = {
    ...withUpdatedAction(packet, actionId, (a) => ({ ...a, executionStatus: "approved" })),
    humanDecision: {
      status: "approved",
      approvedSuggestionHash: packet.suggestionHash,
      approvedActionHashes: [...new Set([...packet.humanDecision.approvedActionHashes, action.actionHash])],
      reviewerReference: reviewerId,
      decidedAt,
      corrections: packet.humanDecision.corrections,
      comment,
    },
  };
  replaceSuggestionPacket(updated);

  const approval: ApprovalRecord = {
    suggestionId: packet.suggestionId,
    suggestionVersion: packet.suggestionVersion,
    suggestionHash: packet.suggestionHash,
    actionId: action.actionId,
    actionVersion: action.actionVersion,
    actionHash: action.actionHash,
    status: "approved",
    reviewerReference: reviewerId,
    decidedAt,
    forkedFromSessionId,
    executedAt: null,
    executedTransactionRef: null,
  };
  recordApproval(approval);
  return { ok: true, packet: updated };
}

/**
 * Edits a proposed action's type/parameters. If the new content is
 * materially different, this bumps actionVersion/actionHash, rebuilds
 * suggestionHash (since it's computed over action hashes), resets
 * executionStatus to "awaiting_approval", and does NOT create an approval
 * record — a fresh `approveAction` call against the new hash is required.
 */
export function editAction(
  suggestionId: string,
  actionId: string,
  edits: { actionType?: ProposedAction["actionType"]; description?: string; parameters?: Record<string, unknown> }
): DecideResult {
  const packet = getSuggestionPacket(suggestionId);
  if (!packet) return { ok: false, error: `No suggestion packet found with id "${suggestionId}".` };
  const action = findAction(packet, actionId);
  if (!action) return { ok: false, error: `No proposed action "${actionId}" on suggestion "${suggestionId}".` };

  const newActionType = edits.actionType ?? action.actionType;
  const newParameters = edits.parameters ?? action.parameters;
  const newDescription = edits.description ?? action.description;

  if (actionContentEqual(action, newActionType, newParameters)) {
    // actionType/parameters are unchanged, so this isn't a material edit —
    // approval (if any) stays valid. A description-only change still needs
    // to be persisted, though: description isn't in the spec's material-field
    // list (customer ref, order id, line items, amount, currency, reason,
    // remedy, policy ref, execution target — all inside `parameters` here),
    // but silently discarding text a human just edited would be a real bug.
    if (newDescription === action.description) {
      return { ok: true, packet };
    }
    const updated = withUpdatedAction(packet, actionId, (a) => ({ ...a, description: newDescription }));
    replaceSuggestionPacket(updated);
    return { ok: true, packet: updated };
  }

  const newVersion = action.actionVersion + 1;
  const newHash = recomputeActionHash({
    actionId: action.actionId,
    actionVersion: newVersion,
    actionType: newActionType,
    description: newDescription,
    parameters: newParameters,
    idempotencyKey: action.idempotencyKey,
  });

  const editedAction: ProposedAction = {
    ...action,
    actionType: newActionType,
    description: newDescription,
    parameters: newParameters,
    actionVersion: newVersion,
    actionHash: newHash,
    executionStatus: "awaiting_approval",
  };

  const updatedActions = packet.proposedActions.map((a) => (a.actionId === actionId ? editedAction : a));
  const newSuggestionVersion = packet.suggestionVersion + 1;
  const newSuggestionHash = recomputeActionHash({
    // Re-hash the suggestion itself over its updated action fingerprints — mirrors
    // buildSuggestionPacket's hashableContent shape closely enough to guarantee a
    // different suggestionHash whenever any action's identity changes.
    actionId: `suggestion:${packet.suggestionId}`,
    actionVersion: newSuggestionVersion,
    actionType: "other",
    description: packet.caseSummary,
    parameters: { actions: updatedActions.map((a) => ({ actionId: a.actionId, actionHash: a.actionHash })) },
    idempotencyKey: null,
  });

  const updated: SuggestionPacket = {
    ...packet,
    proposedActions: updatedActions,
    suggestionVersion: newSuggestionVersion,
    suggestionHash: newSuggestionHash,
    humanDecision: {
      status: "revision_requested",
      approvedSuggestionHash: null,
      approvedActionHashes: packet.humanDecision.approvedActionHashes.filter((h) => h !== action.actionHash),
      reviewerReference: packet.humanDecision.reviewerReference,
      decidedAt: null,
      corrections: [...packet.humanDecision.corrections, `Action "${actionId}" edited; prior approval invalidated.`],
      comment: packet.humanDecision.comment,
    },
  };
  replaceSuggestionPacket(updated);
  return { ok: true, packet: updated };
}

export function rejectAction(suggestionId: string, actionId: string, reviewerId: string, comment: string): DecideResult {
  const packet = getSuggestionPacket(suggestionId);
  if (!packet) return { ok: false, error: `No suggestion packet found with id "${suggestionId}".` };
  const action = findAction(packet, actionId);
  if (!action) return { ok: false, error: `No proposed action "${actionId}" on suggestion "${suggestionId}".` };

  const updated: SuggestionPacket = {
    ...withUpdatedAction(packet, actionId, (a) => ({ ...a, executionStatus: "rejected" })),
    humanDecision: {
      status: "rejected",
      approvedSuggestionHash: null,
      approvedActionHashes: packet.humanDecision.approvedActionHashes.filter((h) => h !== action.actionHash),
      reviewerReference: reviewerId,
      decidedAt: new Date().toISOString(),
      corrections: packet.humanDecision.corrections,
      comment,
    },
  };
  replaceSuggestionPacket(updated);
  return { ok: true, packet: updated };
}

export function requestRevision(suggestionId: string, reviewerId: string, comment: string): DecideResult {
  const packet = getSuggestionPacket(suggestionId);
  if (!packet) return { ok: false, error: `No suggestion packet found with id "${suggestionId}".` };
  const updated: SuggestionPacket = {
    ...packet,
    humanDecision: {
      status: "revision_requested",
      approvedSuggestionHash: null,
      approvedActionHashes: [],
      reviewerReference: reviewerId,
      decidedAt: new Date().toISOString(),
      corrections: [...packet.humanDecision.corrections, comment],
      comment,
    },
  };
  replaceSuggestionPacket(updated);
  return { ok: true, packet: updated };
}

export function addReviewerComment(suggestionId: string, comment: string): DecideResult {
  const packet = getSuggestionPacket(suggestionId);
  if (!packet) return { ok: false, error: `No suggestion packet found with id "${suggestionId}".` };
  const updated: SuggestionPacket = { ...packet, humanDecision: { ...packet.humanDecision, comment } };
  replaceSuggestionPacket(updated);
  return { ok: true, packet: updated };
}
