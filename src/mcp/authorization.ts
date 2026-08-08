/**
 * Server-side MCP authorization boundary (spec sections 10/11/20). This is
 * the ONLY place a side-effecting execution tool (`process_refund`,
 * `create_return`) may be permitted to run. It is deliberately NOT a prompt
 * or a client-side hook the calling agent could skip: `ToolContext.callerRole`
 * is fixed per MCP connection by src/mcp/server.ts's caller (see
 * src/agent/mcpClient.ts, which always opens `advisor_agent`, versus
 * src/approvals/execute.ts, the only code path that ever opens
 * `human_support_agent`) — there is no tool input the model can set to change
 * its own role.
 *
 * Two independent gates must both pass:
 *  1. Role gate — the connection must be `human_support_agent`. An
 *     `advisor_agent` connection is refused unconditionally, before any
 *     other input is even inspected.
 *  2. Execution-authorization gate — the tool input's `executionContext`
 *     must reference an approval record that src/approvals/store.ts
 *     actually has on file, with matching suggestion/action hashes, not
 *     already executed (idempotency), and not expired/invalidated by a
 *     later edit.
 */

import { err, type ToolError } from "../domain/errors.js";
import { HUMAN_EXECUTION_ONLY_TOOLS, type Role } from "../domain/roles.js";
import { lookupApproval } from "../approvals/store.js";

export interface ExecutionContextInput {
  humanActorId: string;
  suggestionId: string;
  suggestionVersion: number;
  suggestionHash: string;
  actionId: string;
  actionVersion: number;
  actionHash: string;
}

export interface AuthorizationDecision {
  allow: boolean;
  blockedError?: ToolError;
}

function blocked(errorResult: ToolError): AuthorizationDecision {
  return { allow: false, blockedError: errorResult };
}

const allowedDecision: AuthorizationDecision = { allow: true };

/**
 * Called by every `HUMAN_EXECUTION_ONLY_TOOLS` handler in toolDefinitions.ts
 * before touching a mock backend. Returns `{allow:false}` with a structured
 * error the tool should return as-is; never throws.
 */
export function authorizeExecution(
  toolName: string,
  callerRole: Role,
  readOnlySession: boolean,
  executionContext: ExecutionContextInput | undefined
): AuthorizationDecision {
  if (!HUMAN_EXECUTION_ONLY_TOOLS.has(toolName)) {
    return allowedDecision;
  }

  if (callerRole !== "human_support_agent") {
    return blocked(
      err(
        "ACCESS",
        "ADVISOR_SIDE_EFFECT_FORBIDDEN",
        `Tool "${toolName}" is a customer-affecting side effect and can never be called from an ` +
          `"${callerRole}" connection. Only a separately authorized human-execution connection, opened ` +
          "after a human approves a specific suggestion/action, may call this tool.",
        false
      )
    );
  }

  if (readOnlySession) {
    return blocked(
      err(
        "ACCESS",
        "SIDE_EFFECT_IN_READ_ONLY_SESSION",
        `Tool "${toolName}" cannot run inside a read-only (forked) session, even for a human_support_agent caller.`,
        false
      )
    );
  }

  if (!executionContext) {
    return blocked(
      err(
        "VALIDATION",
        "MISSING_EXECUTION_CONTEXT",
        `Tool "${toolName}" requires executionContext (approved suggestion/action hashes and the human actor id).`,
        false
      )
    );
  }

  const approval = lookupApproval(executionContext.suggestionId, executionContext.actionId);
  if (!approval) {
    return blocked(
      err(
        "NOT_FOUND",
        "APPROVAL_NOT_FOUND",
        `No approval record found for suggestion "${executionContext.suggestionId}" / action "${executionContext.actionId}".`,
        false
      )
    );
  }

  if (approval.status !== "approved" && approval.status !== "approved_with_changes") {
    return blocked(
      err(
        "ACCESS",
        "ACTION_NOT_APPROVED",
        `Action "${executionContext.actionId}" is not in an approved state (current status: "${approval.status}").`,
        false
      )
    );
  }

  if (approval.suggestionHash !== executionContext.suggestionHash) {
    return blocked(
      err(
        "CONFLICT",
        "SUGGESTION_HASH_MISMATCH",
        "The suggestionHash supplied for execution does not match the hash on the approved suggestion. " +
          "The suggestion may have been edited or regenerated since approval; re-approve before executing.",
        false
      )
    );
  }

  if (approval.actionHash !== executionContext.actionHash) {
    return blocked(
      err(
        "CONFLICT",
        "ACTION_HASH_MISMATCH",
        "The actionHash supplied for execution does not match the hash on the approved action. The action " +
          "was edited after approval; approval is invalidated and must be re-obtained (see src/approvals/decide.ts).",
        false
      )
    );
  }

  if (approval.suggestionVersion !== executionContext.suggestionVersion || approval.actionVersion !== executionContext.actionVersion) {
    return blocked(
      err(
        "CONFLICT",
        "APPROVAL_VERSION_MISMATCH",
        "The suggestion/action version supplied for execution does not match the approved version.",
        false
      )
    );
  }

  if (approval.forkedFromSessionId) {
    return blocked(
      err(
        "ACCESS",
        "FORKED_APPROVAL_NOT_EXECUTABLE",
        "This approval was copied into a forked/read-only investigation session and can never authorize " +
          "execution — forks never inherit executable approvals, by design.",
        false
      )
    );
  }

  if (approval.executedAt) {
    return blocked(
      err(
        "CONFLICT",
        "APPROVAL_ALREADY_EXECUTED",
        `Action "${executionContext.actionId}" was already executed at ${approval.executedAt}; this is a replay guard, not an error to retry.`,
        false
      )
    );
  }

  if (!executionContext.humanActorId) {
    return blocked(err("VALIDATION", "MISSING_HUMAN_ACTOR", "executionContext.humanActorId is required.", false));
  }

  return allowedDecision;
}
