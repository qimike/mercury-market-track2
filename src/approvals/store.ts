/**
 * In-memory approval record store — the source of truth src/mcp/authorization.ts
 * checks before allowing `process_refund`/`create_return` to run. Keyed by
 * (suggestionId, actionId) so each proposed action within a packet has its
 * own independent approval/version/hash lineage (spec section 20: "approval
 * must be tied to... action ID, action version, action hash").
 */

export interface ApprovalRecord {
  suggestionId: string;
  suggestionVersion: number;
  suggestionHash: string;
  actionId: string;
  actionVersion: number;
  actionHash: string;
  status: "approved" | "approved_with_changes" | "rejected" | "revision_requested" | "pending";
  reviewerReference: string | null;
  decidedAt: string | null;
  /**
   * Set when this approval record was copied into a forked/read-only session
   * rather than created directly against the main session — such a record
   * can never authorize execution (src/mcp/authorization.ts checks this),
   * satisfying "forks never inherit executable approvals."
   */
  forkedFromSessionId: string | null;
  executedAt: string | null;
  executedTransactionRef: string | null;
}

const approvals = new Map<string, ApprovalRecord>();

function key(suggestionId: string, actionId: string): string {
  return `${suggestionId}:${actionId}`;
}

export function recordApproval(record: ApprovalRecord): void {
  approvals.set(key(record.suggestionId, record.actionId), record);
}

export function lookupApproval(suggestionId: string, actionId: string): ApprovalRecord | undefined {
  return approvals.get(key(suggestionId, actionId));
}

export function markExecuted(suggestionId: string, actionId: string, transactionRef: string, executedAt: string): void {
  const record = approvals.get(key(suggestionId, actionId));
  if (record) {
    record.executedAt = executedAt;
    record.executedTransactionRef = transactionRef;
  }
}

export function listApprovals(): ApprovalRecord[] {
  return [...approvals.values()];
}

export function _resetApprovalStoreMockState(): void {
  approvals.clear();
}
