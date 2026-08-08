/**
 * The ONLY code path in this repository that opens an MCP connection bound
 * to the `human_support_agent` role and the ONLY code path that ever calls
 * `process_refund`/`create_return` (spec section 20, Pass 7 "approved
 * execution"). Every call here:
 *  1. requires an on-file approval (src/approvals/store.ts) matching the
 *     exact suggestion/action hash+version passed in,
 *  2. re-fetches fresh backend data and reruns arithmetic/currency/balance
 *     checks against it (src/approvals/revalidate.ts) — never trusts the
 *     packet's numbers as still current,
 *  3. is refused a second time for the same action once already executed
 *     (idempotency; src/mcp/authorization.ts's APPROVAL_ALREADY_EXECUTED
 *     check, backed by process_refund's own idempotencyKey guarantee).
 */

import { connectMercuryMcp } from "../agent/mcpClient.js";
import { getSuggestionPacket, replaceSuggestionPacket } from "../advisor/packetStore.js";
import { lookupApproval, markExecuted } from "./store.js";
import { revalidateRefundAmount } from "./revalidate.js";
import type { SuggestionPacket, ProposedAction } from "../domain/schemas/suggestionPacket.js";

export interface ExecuteActionOptions {
  suggestionId: string;
  actionId: string;
  humanActorId: string;
}

export type ExecuteResult =
  | { ok: true; transactionId?: string; returnId?: string }
  | { ok: false; error: string };

function refundParams(action: ProposedAction): { orderId: string; customerId: string; amount: string; currency: string; reason: string } | null {
  const p = action.parameters as Record<string, unknown>;
  if (typeof p.orderId !== "string" || typeof p.customerId !== "string" || typeof p.amount !== "string" || typeof p.currency !== "string") return null;
  return { orderId: p.orderId, customerId: p.customerId, amount: p.amount, currency: p.currency, reason: typeof p.reason === "string" ? p.reason : action.description };
}

function returnParams(action: ProposedAction): { orderId: string; customerId: string; lineItems: Array<{ sku: string; quantity: number }>; reason: string } | null {
  const p = action.parameters as Record<string, unknown>;
  if (typeof p.orderId !== "string" || typeof p.customerId !== "string" || !Array.isArray(p.lineItems)) return null;
  return { orderId: p.orderId, customerId: p.customerId, lineItems: p.lineItems as Array<{ sku: string; quantity: number }>, reason: typeof p.reason === "string" ? p.reason : action.description };
}

export async function executeApprovedAction(options: ExecuteActionOptions): Promise<ExecuteResult> {
  const packet = getSuggestionPacket(options.suggestionId);
  if (!packet) return { ok: false, error: `No suggestion packet found with id "${options.suggestionId}".` };
  const action = packet.proposedActions.find((a) => a.actionId === options.actionId);
  if (!action) return { ok: false, error: `No proposed action "${options.actionId}" on suggestion "${options.suggestionId}".` };

  const approval = lookupApproval(options.suggestionId, options.actionId);
  if (!approval || (approval.status !== "approved" && approval.status !== "approved_with_changes")) {
    return { ok: false, error: `Action "${options.actionId}" is not currently approved — cannot execute.` };
  }
  if (approval.executedAt) {
    return { ok: false, error: `Action "${options.actionId}" was already executed at ${approval.executedAt} (ref: ${approval.executedTransactionRef}) — this is a replay guard, not a retry.` };
  }

  const executionContext = {
    humanActorId: options.humanActorId,
    suggestionId: packet.suggestionId,
    suggestionVersion: packet.suggestionVersion,
    suggestionHash: packet.suggestionHash,
    actionId: action.actionId,
    actionVersion: action.actionVersion,
    actionHash: action.actionHash,
  };

  const mcp = await connectMercuryMcp({
    traceId: `exec-${action.actionId}-v${action.actionVersion}`,
    readOnlySession: false,
    callerRole: "human_support_agent",
  });

  try {
    if (action.actionType === "propose_refund") {
      const params = refundParams(action);
      if (!params) return { ok: false, error: "propose_refund action is missing required parameters (orderId, customerId, amount, currency)." };

      const freshHistory = await mcp.callTool("get_payment_history", { orderId: params.orderId });
      const revalidation = revalidateRefundAmount(
        { amount: params.amount, currency: params.currency },
        freshHistory as unknown as { success: boolean; remainingRefundableAmount?: string; currency?: string }
      );
      if (!revalidation.ok) return { ok: false, error: revalidation.error };

      const idempotencyKey = `${packet.caseId}:${action.actionId}:v${action.actionVersion}`;
      const result = await mcp.callTool("process_refund", { ...params, idempotencyKey, executionContext });
      if (!result.success) return { ok: false, error: (result as { error: { message: string } }).error.message };

      const transactionId = (result as { transactionId?: string }).transactionId;
      finalizeExecution(packet, action, transactionId ?? "unknown");
      return { ok: true, transactionId };
    }

    if (action.actionType === "initiate_return") {
      const params = returnParams(action);
      if (!params) return { ok: false, error: "initiate_return action is missing required parameters (orderId, customerId, lineItems)." };

      const result = await mcp.callTool("create_return", { ...params, executionContext });
      if (!result.success) return { ok: false, error: (result as { error: { message: string } }).error.message };

      const returnId = (result as { returnRecord?: { returnId: string } }).returnRecord?.returnId;
      finalizeExecution(packet, action, returnId ?? "unknown");
      return { ok: true, returnId };
    }

    return { ok: false, error: `Action type "${action.actionType}" has no execution handler — only propose_refund and initiate_return are executable.` };
  } finally {
    await mcp.close();
  }
}

function finalizeExecution(packet: SuggestionPacket, action: ProposedAction, reference: string): void {
  const executedAt = new Date().toISOString();
  markExecuted(packet.suggestionId, action.actionId, reference, executedAt);
  const updated: SuggestionPacket = {
    ...packet,
    proposedActions: packet.proposedActions.map((a) => (a.actionId === action.actionId ? { ...a, executionStatus: "executed" } : a)),
  };
  replaceSuggestionPacket(updated);
}
