/**
 * Advisor-side programmatic pre-checks. These run BEFORE a tool call ever
 * reaches MCP (src/agent/toolExecutor.ts calls this first) — they are
 * defense-in-depth, fail-fast checks, NOT the authoritative enforcement
 * boundary. The authoritative boundary is server-side, in
 * src/mcp/authorization.ts, which refuses `process_refund`/`create_return`
 * unconditionally for any connection that isn't bound to the
 * `human_support_agent` role (a role the advisor's connection can never
 * hold — see src/agent/mcpClient.ts). Even if this file were deleted
 * entirely, the advisor could still never execute a side effect; this file
 * exists so a misguided attempt fails immediately and cheaply, with a clear
 * corrective message, instead of round-tripping to MCP first.
 *
 * Two checks, per the spec:
 *  1. Identity enforcement — customer-specific read tools (lookup_order,
 *     get_payment_history) require identityStatus === "verified" in the
 *     case context; a locked account blocks and forces escalation.
 *  2. Advisor-forbidden tools — process_refund/create_return are refused
 *     unconditionally for the advisor loop, regardless of anything a prompt
 *     claims. The advisor's only path to these actions is proposing them
 *     inside a SuggestionPacket for later human execution
 *     (src/approvals/execute.ts).
 */

import { err, type ToolError } from "../domain/errors.js";
import { HUMAN_EXECUTION_ONLY_TOOLS } from "../domain/roles.js";

export const CUSTOMER_PROTECTED_TOOLS = new Set(["lookup_order", "get_payment_history"]);

export interface HookContext {
  caseId: string;
  identityStatus: "unverified" | "verified" | "locked";
  caseCurrency?: string;
  policyDecision?: "eligible" | "ineligible" | "partially_eligible" | "undetermined";
  policyConfidence?: "high" | "medium" | "low";
}

export interface HookDecision {
  allow: boolean;
  overrideInput?: Record<string, unknown>;
  blockedError?: ToolError;
  forceEscalation: boolean;
}

function allowed(overrideInput?: Record<string, unknown>): HookDecision {
  return { allow: true, overrideInput, forceEscalation: false };
}

function blocked(errorResult: ToolError, forceEscalation: boolean): HookDecision {
  return { allow: false, blockedError: errorResult, forceEscalation };
}

export function runPreToolHooks(
  toolName: string,
  _input: Record<string, unknown>,
  ctx: HookContext
): HookDecision {
  if (HUMAN_EXECUTION_ONLY_TOOLS.has(toolName)) {
    return blocked(
      err(
        "ACCESS",
        "ADVISOR_SIDE_EFFECT_FORBIDDEN",
        `The advisor may never call "${toolName}" directly. Propose it as a proposedAction in the ` +
          "suggestion packet instead — only a human_support_agent executing an approved action may " +
          "call this tool (enforced server-side regardless of this check).",
        false
      ),
      false
    );
  }

  if (ctx.identityStatus === "locked" && CUSTOMER_PROTECTED_TOOLS.has(toolName)) {
    return blocked(
      err(
        "ACCESS",
        "ACCOUNT_LOCKED",
        "Customer account is locked pending fraud review; customer-specific lookups are blocked.",
        false
      ),
      true
    );
  }

  if (ctx.identityStatus !== "verified" && CUSTOMER_PROTECTED_TOOLS.has(toolName)) {
    return blocked(
      err(
        "ACCESS",
        "IDENTITY_NOT_VERIFIED",
        `Tool "${toolName}" requires a verified customer identity. Call verify_customer_identity first.`,
        false
      ),
      false
    );
  }

  return allowed();
}
