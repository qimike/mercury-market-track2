/**
 * Programmatic safeguards. These are plain TypeScript checks the agent loop's
 * tool executor (src/agent/toolExecutor.ts) runs BEFORE a tool call ever
 * reaches the MCP layer — they exist precisely because prompts are not a
 * control. No system prompt wording can make `runPreToolHooks` skip the
 * identity check or let a refund past the mandatory-escalation threshold;
 * the only way to change this behavior is to edit this file (and its tests).
 *
 * Four safeguards, per the spec:
 *  1. Identity enforcement — customer-specific order/return/refund tools
 *     require identityStatus === "verified" in the case context.
 *  2. Refund threshold enforcement — amounts at/above the configured
 *     mandatory-escalation limit are blocked from autonomous execution,
 *     currency must match the order's currency, and (as defense in depth
 *     alongside the payments mock's own check) amount must not exceed the
 *     remaining refundable balance when that fact is already known.
 *  3. Policy-confidence enforcement — process_refund is blocked unless this
 *     case's most recently evaluated policy (CaseContext.policyDecision/
 *     policyConfidence, set from an actual evaluate_policy tool result) is
 *     eligible/partially_eligible at confidence "high". This is what makes
 *     "ambiguous policy -> mandatory escalation" a code guarantee rather
 *     than something only the subagent prompts ask for.
 *  4. Idempotency — every process_refund call is forced onto a
 *     deterministic, case+order-scoped idempotency key. The model's own
 *     choice of key (if any) is never trusted for this.
 */

import { err, type ToolError } from "../domain/errors.js";
import { parseMoney, compareMoney } from "../domain/money.js";
import { config } from "../domain/config.js";

export const CUSTOMER_PROTECTED_TOOLS = new Set([
  "lookup_order",
  "get_payment_history",
  "create_return",
  "process_refund",
]);

export interface HookContext {
  caseId: string;
  identityStatus: "unverified" | "verified" | "locked";
  /** Known remaining refundable balance for the order in play, if already fetched this case. */
  knownRemainingRefundableAmount?: { amount: string; currency: string };
  /** The case's own currency (from CaseFacts), used to catch mismatches before the tool call. */
  caseCurrency?: string;
  /** From the most recent evaluate_policy result this case (see CaseContext.ingest). */
  policyDecision?: "eligible" | "ineligible" | "partially_eligible" | "undetermined";
  policyConfidence?: "high" | "medium" | "low";
}

export interface HookDecision {
  allow: boolean;
  /** Fields to merge into the tool input before calling it (e.g. a forced idempotencyKey). */
  overrideInput?: Record<string, unknown>;
  /** Populated when allow === false: the structured error to return as the tool result. */
  blockedError?: ToolError;
  /** Signals the coordinator should treat this as a mandatory-escalation trigger. */
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
  input: Record<string, unknown>,
  ctx: HookContext
): HookDecision {
  if (ctx.identityStatus === "locked" && CUSTOMER_PROTECTED_TOOLS.has(toolName)) {
    return blocked(
      err(
        "ACCESS",
        "ACCOUNT_LOCKED",
        "Customer account is locked pending fraud review; customer-specific operations are blocked.",
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

  if (toolName === "process_refund") {
    return runRefundHooks(input, ctx);
  }

  return allowed();
}

function runRefundHooks(input: Record<string, unknown>, ctx: HookContext): HookDecision {
  const amountRaw = String(input.amount ?? "");
  const currencyRaw = String(input.currency ?? "");

  const parsed = parseMoney(amountRaw, currencyRaw);
  if (!parsed.ok) {
    return blocked(parsed.error, false);
  }

  if (ctx.caseCurrency && parsed.value.currency !== ctx.caseCurrency) {
    return blocked(
      err(
        "VALIDATION",
        "CURRENCY_MISMATCH",
        `Refund currency "${parsed.value.currency}" does not match the case's currency "${ctx.caseCurrency}".`,
        false
      ),
      true
    );
  }

  const eligibleDecisions = new Set(["eligible", "partially_eligible"]);
  if (!ctx.policyDecision || !eligibleDecisions.has(ctx.policyDecision) || ctx.policyConfidence !== "high") {
    return blocked(
      err(
        "POLICY_AMBIGUITY",
        "POLICY_NOT_ELIGIBLE_FOR_AUTONOMOUS_REFUND",
        `Autonomous refund requires a policy decision of "eligible" or "partially_eligible" at ` +
          `confidence "high"; this case's most recently evaluated policy was decision=` +
          `${ctx.policyDecision ?? "none"}, confidence=${ctx.policyConfidence ?? "none"}.`,
        false
      ),
      true
    );
  }

  const mandatoryLimit = config.mandatoryEscalationLimit(parsed.value.currency);
  if (compareMoney(parsed.value, mandatoryLimit) >= 0) {
    return blocked(
      err(
        "ACCESS",
        "REFUND_THRESHOLD_EXCEEDED",
        `Refund amount ${amountRaw} ${parsed.value.currency} is at/above the mandatory escalation ` +
          `limit and cannot be executed autonomously.`,
        false
      ),
      true
    );
  }

  if (ctx.knownRemainingRefundableAmount) {
    const known = parseMoney(
      ctx.knownRemainingRefundableAmount.amount,
      ctx.knownRemainingRefundableAmount.currency
    );
    if (known.ok && compareMoney(parsed.value, known.value) > 0) {
      return blocked(
        err(
          "CONFLICT",
          "REFUND_EXCEEDS_BALANCE",
          `Refund amount ${amountRaw} ${parsed.value.currency} exceeds the known remaining refundable ` +
            `balance of ${ctx.knownRemainingRefundableAmount.amount} ${ctx.knownRemainingRefundableAmount.currency}.`,
          false
        ),
        true
      );
    }
  }

  const idempotencyKey = `${ctx.caseId}:refund:${input.orderId ?? "unknown-order"}`;
  return allowed({ idempotencyKey });
}
