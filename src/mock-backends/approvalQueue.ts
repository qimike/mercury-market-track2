/**
 * Mock human-approval-queue adapter (spec section 6/11). Two queues:
 *  - the escalation queue (typed items created by `escalate_to_human`,
 *    replacing Track 1's autonomous-coordinator escalation packets — every
 *    Track 2 escalation is a queue item a human_support_agent or
 *    policy_reviewer works from, never a terminal "case closed" event);
 *  - the approval queue (one entry per suggestion packet awaiting a human
 *    decision, written by src/advisor/passes/packet.ts and updated by
 *    src/approvals/decide.ts).
 * Both are append-only history logs over a mutable "current status" field —
 * the history itself is never rewritten (audit requirement, spec section 25).
 */

import { ok, fail, type ToolResult } from "../domain/errors.js";
import type { EscalationPacket } from "../domain/schemas.js";

export interface EscalationHistoryEntry {
  actor: string;
  action: string;
  note: string;
  at: string;
}

export interface EscalationQueueItem {
  escalationId: string;
  caseId: string;
  sessionId: string;
  suggestionId: string | null;
  reason: string;
  riskFlags: string[];
  status: "open" | "in_review" | "resolved";
  createdAt: string;
  history: EscalationHistoryEntry[];
  packet: EscalationPacket;
}

const escalations = new Map<string, EscalationQueueItem>();
let escalationSeq = 0;

export async function enqueueEscalation(
  packet: EscalationPacket,
  sessionId: string,
  suggestionId: string | null
): Promise<ToolResult<{ escalationId: string; item: EscalationQueueItem }>> {
  if (!packet.caseId || !packet.escalationReason) {
    return fail("VALIDATION", "MISSING_FIELDS", "caseId and escalationReason are required to escalate.", false);
  }
  escalationSeq += 1;
  const escalationId = `esc_${String(escalationSeq).padStart(4, "0")}`;
  const createdAt = new Date().toISOString();
  const item: EscalationQueueItem = {
    escalationId,
    caseId: packet.caseId,
    sessionId,
    suggestionId,
    reason: packet.escalationReason,
    riskFlags: packet.riskFlags,
    status: "open",
    createdAt,
    history: [{ actor: "advisor_agent", action: "escalated", note: packet.escalationReason, at: createdAt }],
    packet,
  };
  escalations.set(escalationId, item);
  return ok({ escalationId, item });
}

export function getEscalation(escalationId: string): EscalationQueueItem | undefined {
  return escalations.get(escalationId);
}

export function listEscalations(): EscalationQueueItem[] {
  return [...escalations.values()];
}

export function updateEscalationStatus(
  escalationId: string,
  status: EscalationQueueItem["status"],
  actor: string,
  note: string
): void {
  const item = escalations.get(escalationId);
  if (!item) return;
  item.status = status;
  item.history.push({ actor, action: `status_changed:${status}`, note, at: new Date().toISOString() });
}

// NOTE: a separate "approval queue" snapshot (as opposed to the
// suggestion-packet-embedded humanDecision this codebase actually uses) was
// scaffolded here but never wired to any code path — src/approvals/store.ts
// plus src/advisor/packetStore.ts's humanDecision field are the actual
// source of truth for approval status. Removed rather than left as dead code.

export function _resetApprovalQueueMockState(): void {
  escalations.clear();
  escalationSeq = 0;
}
