/**
 * Risk-tiered approval-count gate (spec section 6/10/45#9-10): a high-risk
 * proposed action (amount at/above config.refundLimit, or low/medium policy
 * confidence, or unverified identity) requires 2 independent human
 * approvals before it may be executed; everything else requires 1. This is
 * advisory bookkeeping on top of — never a substitute for —
 * src/mcp/authorization.ts's hard hash/role checks, which apply regardless
 * of how many approvals were recorded.
 */

import { compareMoney, parseMoney } from "../domain/money.js";
import { config } from "../domain/config.js";
import type { ProposedAction } from "../domain/schemas/suggestionPacket.js";
import { listApprovals } from "./store.js";

export type RiskTier = "standard" | "high";

export function classifyActionRisk(action: ProposedAction, identityVerified: boolean, policyConfidence: "high" | "medium" | "low" | null): RiskTier {
  if (!identityVerified || policyConfidence !== "high") return "high";
  const params = action.parameters as Record<string, unknown>;
  if (typeof params.amount === "string" && typeof params.currency === "string") {
    const parsed = parseMoney(params.amount, params.currency);
    if (parsed.ok && compareMoney(parsed.value, config.refundLimit(parsed.value.currency)) >= 0) return "high";
  }
  return "standard";
}

export function requiredApprovals(tier: RiskTier): number {
  return tier === "high" ? 2 : 1;
}

export function hasEnoughApprovals(suggestionId: string, actionId: string, tier: RiskTier): boolean {
  const approvedCount = listApprovals().filter(
    (a) => a.suggestionId === suggestionId && a.actionId === actionId && (a.status === "approved" || a.status === "approved_with_changes")
  ).length;
  return approvedCount >= requiredApprovals(tier);
}
