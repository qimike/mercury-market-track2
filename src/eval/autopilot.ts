/**
 * A generic, deterministic "autopilot" FakeClaudeClient script used by both
 * the evaluation harness (src/eval/runEval.ts) and integration tests. Rather
 * than hand-scripting exact call indices per scenario (fragile once multiple
 * subagents run concurrently), this inspects `request.system` to determine
 * which role is being asked (coordinator vs. one of the four subagents) and
 * keeps small per-role local state, so it works correctly regardless of how
 * the coordinator's parallel delegations interleave.
 *
 * This is intentionally simple, rule-based logic — it exists to drive the
 * real agent loop/hooks/validation code deterministically for evaluation, not
 * to demonstrate model reasoning quality.
 */

import type { ClaudeRequest, ClaudeResponse } from "../agent/claudeClient.js";
import { COORDINATOR_SYSTEM_PROMPT } from "../agent/prompts/coordinator.js";
import { IDENTITY_SUBAGENT_PROMPT } from "../agent/prompts/identity.js";
import { ORDER_SUBAGENT_PROMPT } from "../agent/prompts/order.js";
import { POLICY_SUBAGENT_PROMPT } from "../agent/prompts/policy.js";
import { REFUND_SUBAGENT_PROMPT } from "../agent/prompts/refund.js";
import type { IdentityFinding, OrderFinding, PolicyFinding, RefundFinding, PolicyCitation } from "../domain/schemas.js";
import { config } from "../domain/config.js";
import { parseMoney, compareMoney } from "../domain/money.js";

export interface ScenarioInput {
  caseId: string;
  customerId: string;
  verificationValue?: string;
  orderId: string;
  region: string;
  sku: string;
  issueType: "return" | "refund_request";
  requestedAmount: string;
  currency: string;
  reason: string;
  deliveryDate: string | null;
  asOfDate: string;
}

function lastToolResultFor(request: ClaudeRequest, toolUseName?: string): any {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const content = request.messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as any[]) {
      if (block.type === "tool_result") {
        try {
          return JSON.parse(block.content);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function textResponse(text: string): ClaudeResponse {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): ClaudeResponse {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use" };
}

function multiToolUse(calls: Array<{ id: string; name: string; input: Record<string, unknown> }>): ClaudeResponse {
  return { content: calls.map((c) => ({ type: "tool_use" as const, ...c })), stopReason: "tool_use" };
}

export function createAutopilot(scenario: ScenarioInput): (callIndex: number, request: ClaudeRequest) => ClaudeResponse {
  let idCounter = 0;
  const nextId = () => `call_${(idCounter += 1)}`;

  // Per-role step counters and captured findings, keyed by system prompt identity.
  let identityStep = 0;
  let orderStep = 0;
  let policyStep = 0;
  let refundStep = 0;

  let identityFinding: IdentityFinding | null = null;
  let orderFinding: OrderFinding | null = null;
  let policyFinding: PolicyFinding | null = null;
  let refundFinding: RefundFinding | null = null;

  // Coordinator-level dedup: has it already delegated to order+policy this run?
  let delegatedOrderPolicy = false;
  let delegatedRefund = false;

  return (_callIndex, request) => {
    switch (request.system) {
      case IDENTITY_SUBAGENT_PROMPT: {
        identityStep += 1;
        if (identityStep === 1) {
          return toolUse(nextId(), "get_customer", { customerId: scenario.customerId });
        }
        const customerResult = lastToolResultFor(request);
        if (identityStep === 2 && customerResult?.success && customerResult.customer?.identityStatus === "unverified" && scenario.verificationValue) {
          return toolUse(nextId(), "verify_customer_identity", {
            customerId: scenario.customerId,
            verificationValue: scenario.verificationValue,
          });
        }
        const verifyResult = customerResult;
        const status = customerResult?.customer?.identityStatus ?? verifyResult?.identityStatus ?? "unverified";
        const verified = status === "verified";
        identityFinding = {
          caseId: scenario.caseId,
          customerId: scenario.customerId,
          identityStatus: status,
          verified,
          notes: verified ? "Verified via supplied value." : `Not verified (status: ${status}).`,
        };
        return toolUse(nextId(), "submit_identity_finding", identityFinding as unknown as Record<string, unknown>);
      }

      case ORDER_SUBAGENT_PROMPT: {
        orderStep += 1;
        if (orderStep === 1) {
          return toolUse(nextId(), "lookup_order", { orderId: scenario.orderId, requestingCustomerId: scenario.customerId });
        }
        if (orderStep === 2) {
          const orderResult = lastToolResultFor(request);
          if (!orderResult?.success) {
            orderFinding = {
              caseId: scenario.caseId,
              orderId: scenario.orderId,
              orderExists: orderResult?.error?.errorCode !== "ORDER_NOT_FOUND",
              customerMatches: orderResult?.error?.errorCode !== "ORDER_OWNERSHIP_MISMATCH",
              status: null,
              currency: null,
              region: null,
              deliveryDate: null,
              lineItems: [],
              amountPaid: null,
              notes: orderResult?.error?.message ?? "Order lookup failed.",
            };
            return toolUse(nextId(), "submit_order_finding", orderFinding as unknown as Record<string, unknown>);
          }
          return toolUse(nextId(), "get_payment_history", { orderId: scenario.orderId });
        }
        const orderResult = (() => {
          for (const m of request.messages) {
            if (!Array.isArray(m.content)) continue;
            for (const b of m.content as any[]) {
              if (b.type === "tool_result") {
                try {
                  const parsed = JSON.parse(b.content);
                  if (parsed.order) return parsed;
                } catch {
                  /* ignore */
                }
              }
            }
          }
          return null;
        })();
        orderFinding = {
          caseId: scenario.caseId,
          orderId: scenario.orderId,
          orderExists: true,
          customerMatches: true,
          status: orderResult?.order?.status ?? null,
          currency: orderResult?.order?.currency ?? null,
          region: orderResult?.order?.region ?? null,
          deliveryDate: orderResult?.order?.deliveryDate ?? null,
          lineItems: orderResult?.order?.lineItems ?? [],
          amountPaid: orderResult?.order?.amountPaid
            ? { amount: orderResult.order.amountPaid, currency: orderResult.order.currency }
            : null,
          notes: "Order retrieved successfully.",
        };
        return toolUse(nextId(), "submit_order_finding", orderFinding as unknown as Record<string, unknown>);
      }

      case POLICY_SUBAGENT_PROMPT: {
        policyStep += 1;
        if (policyStep === 1) {
          return toolUse(nextId(), "evaluate_policy", {
            region: scenario.region,
            sku: scenario.sku,
            issueType: scenario.issueType,
            deliveryDate: scenario.deliveryDate,
            asOfDate: scenario.asOfDate,
          });
        }
        const policyResult = lastToolResultFor(request);
        policyFinding = {
          caseId: scenario.caseId,
          decision: policyResult?.decision ?? "undetermined",
          confidence: policyResult?.confidence ?? "low",
          citations: (policyResult?.citations as PolicyCitation[]) ?? [],
          conflicts: policyResult?.conflicts ?? [],
          ambiguities: policyResult?.ambiguities ?? [],
          notes: "Policy evaluated.",
        };
        return toolUse(nextId(), "submit_policy_finding", policyFinding as unknown as Record<string, unknown>);
      }

      case REFUND_SUBAGENT_PROMPT: {
        refundStep += 1;
        if (refundStep === 1) {
          return toolUse(nextId(), "get_payment_history", { orderId: scenario.orderId });
        }
        if (refundStep === 2) {
          const historyResult = lastToolResultFor(request);
          const remaining = historyResult?.remainingRefundableAmount;
          const currencyMatches = historyResult?.currency === scenario.currency;
          const remainingMoney = remaining !== undefined ? parseMoney(remaining, historyResult?.currency ?? scenario.currency) : null;
          const requestedMoney = parseMoney(scenario.requestedAmount, scenario.currency);
          const withinBalance =
            currencyMatches &&
            remainingMoney?.ok &&
            requestedMoney.ok &&
            compareMoney(requestedMoney.value, remainingMoney.value) <= 0;
          if (withinBalance) {
            return toolUse(nextId(), "process_refund", {
              orderId: scenario.orderId,
              customerId: scenario.customerId,
              amount: scenario.requestedAmount,
              currency: scenario.currency,
              reason: scenario.reason,
              idempotencyKey: "autopilot-key",
            });
          }
          refundFinding = {
            caseId: scenario.caseId,
            routing: "escalate",
            refundTransactionId: null,
            amount: null,
            reason: scenario.reason,
            blockedReason: `Remaining refundable balance (${remaining}) insufficient or currency mismatch.`,
          };
          return toolUse(nextId(), "submit_refund_finding", refundFinding as unknown as Record<string, unknown>);
        }
        const refundResult = lastToolResultFor(request);
        if (refundResult?.success) {
          refundFinding = {
            caseId: scenario.caseId,
            routing: "autonomous",
            refundTransactionId: refundResult.transactionId,
            amount: { amount: refundResult.amount, currency: refundResult.currency },
            reason: scenario.reason,
            blockedReason: null,
          };
        } else {
          refundFinding = {
            caseId: scenario.caseId,
            routing: "escalate",
            refundTransactionId: null,
            amount: null,
            reason: scenario.reason,
            blockedReason: refundResult?.error?.message ?? "Refund could not be executed.",
          };
        }
        return toolUse(nextId(), "submit_refund_finding", refundFinding as unknown as Record<string, unknown>);
      }

      case COORDINATOR_SYSTEM_PROMPT:
      default: {
        if (!identityFinding) {
          return toolUse(nextId(), "delegate_to_identity_subagent", {
            customerId: scenario.customerId,
            ...(scenario.verificationValue ? { verificationValue: scenario.verificationValue } : {}),
          });
        }

        if (identityFinding.identityStatus === "locked") {
          return toolUse(
            nextId(),
            "escalate_to_human",
            buildEscalationInput(scenario, "Account is locked pending fraud review.", "low", [], "locked")
          );
        }
        if (!identityFinding.verified) {
          return toolUse(
            nextId(),
            "escalate_to_human",
            buildEscalationInput(scenario, "Customer identity could not be verified.", "low", [], "unverified")
          );
        }

        if (!delegatedOrderPolicy) {
          delegatedOrderPolicy = true;
          return multiToolUse([
            { id: nextId(), name: "delegate_to_order_subagent", input: { orderId: scenario.orderId, customerId: scenario.customerId } },
            {
              id: nextId(),
              name: "delegate_to_policy_subagent",
              input: {
                region: scenario.region,
                sku: scenario.sku,
                issueType: scenario.issueType,
                deliveryDate: scenario.deliveryDate,
                asOfDate: scenario.asOfDate,
              },
            },
          ]);
        }

        if (!orderFinding || !policyFinding) {
          // Findings not yet captured this turn (still mid-delegation); nudge once more.
          return textResponse("Waiting on subagent findings.");
        }

        if (!orderFinding.orderExists || !orderFinding.customerMatches) {
          return toolUse(
            nextId(),
            "escalate_to_human",
            buildEscalationInput(scenario, `Order lookup failed: ${orderFinding.notes}`, "low", [])
          );
        }

        if (policyFinding.decision === "undetermined" || policyFinding.confidence === "low" || policyFinding.conflicts.length > 0) {
          return toolUse(
            nextId(),
            "escalate_to_human",
            buildEscalationInput(
              scenario,
              policyFinding.conflicts.length > 0
                ? "Policy conflict detected; cannot autonomously determine eligibility."
                : "Policy confidence is low or undetermined.",
              policyFinding.confidence,
              policyFinding.citations
            )
          );
        }

        const requestedForThreshold = parseMoney(scenario.requestedAmount, scenario.currency);
        const mandatoryLimit = config.mandatoryEscalationLimit(scenario.currency);
        if (requestedForThreshold.ok && compareMoney(requestedForThreshold.value, mandatoryLimit) >= 0) {
          return toolUse(
            nextId(),
            "escalate_to_human",
            buildEscalationInput(scenario, "Requested amount is at/above the mandatory escalation threshold.", policyFinding.confidence, policyFinding.citations)
          );
        }

        if (!delegatedRefund) {
          delegatedRefund = true;
          return toolUse(nextId(), "delegate_to_refund_subagent", {
            orderId: scenario.orderId,
            customerId: scenario.customerId,
            requestedAmount: scenario.requestedAmount,
            currency: scenario.currency,
            policyDecision: policyFinding.decision,
            policyConfidence: policyFinding.confidence,
            reason: scenario.reason,
          });
        }

        if (!refundFinding) {
          return textResponse("Waiting on refund subagent finding.");
        }

        if (refundFinding.routing === "autonomous" && refundFinding.refundTransactionId && refundFinding.amount) {
          return toolUse(nextId(), "resolve_case", {
            caseId: scenario.caseId,
            outcome: "resolved_autonomously",
            customerSummary: `Your refund of ${refundFinding.amount.amount} ${refundFinding.amount.currency} has been processed.`,
            internalSummary: "Eligible refund processed autonomously per policy citation.",
            refundTransactionId: refundFinding.refundTransactionId,
            refundAmount: refundFinding.amount,
            policyCitations: policyFinding.citations,
            actionsTaken: ["Verified identity", "Processed refund"],
            provenance: [],
          });
        }

        return toolUse(
          nextId(),
          "escalate_to_human",
          buildEscalationInput(scenario, refundFinding.blockedReason ?? "Refund could not be executed autonomously.", policyFinding.confidence, policyFinding.citations)
        );
      }
    }
  };
}

function buildEscalationInput(
  scenario: ScenarioInput,
  reason: string,
  confidence: string,
  citations: PolicyCitation[],
  identityState: "unverified" | "verified" | "locked" = "verified"
): Record<string, unknown> {
  return {
    caseId: scenario.caseId,
    traceId: scenario.caseId,
    customerSummary: "We're taking a closer look at your request and a specialist will follow up.",
    internalSummary: reason,
    identityState,
    orderFacts: null,
    paymentFacts: null,
    requestedAction: scenario.issueType === "return" ? "return" : "refund",
    requestedAmount: { amount: scenario.requestedAmount, currency: scenario.currency },
    eligibleAmount: null,
    policyDecision: "undetermined",
    policyCitations: citations,
    policyVersion: null,
    policyEffectiveDate: null,
    confidence,
    ambiguities: [reason],
    riskFlags: [],
    actionsAlreadyTaken: [],
    toolFailures: [],
    escalationReason: reason,
    recommendedHumanAction: "Review the case facts and subagent findings before taking action.",
    provenance: [],
  };
}
