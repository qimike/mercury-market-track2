/**
 * The coordinator: the top-level deterministic AgentLoop (src/agent/loop.ts)
 * configured with the Mercury Market system prompt plus four
 * `delegate_to_*_subagent` local tools. Each delegate tool runs a bounded,
 * independently-scoped nested loop (src/agent/subagentLoop.ts) for one of the
 * four specialists and returns a structured, schema-validated finding — this
 * is our coordinator/subagent equivalent of the Agent SDK's Task mechanism
 * (see README "Why not the Claude Agent SDK's own Task tool" for the
 * reasoning), built on the same hooks/tool-executor/context machinery so
 * enforcement never depends on which "agent" happens to be talking.
 */

import type { ClaudeClient } from "./claudeClient.js";
import type { MercuryMcpConnection } from "./mcpClient.js";
import { AgentLoop, type LocalToolSpec, type LoopResult } from "./loop.js";
import { CaseContext } from "./context.js";
import { COORDINATOR_SYSTEM_PROMPT } from "./prompts/coordinator.js";
import { ok, fail } from "../domain/errors.js";
import { runIdentitySubagent } from "./subagents/identity.js";
import { runOrderSubagent } from "./subagents/order.js";
import { runPolicySubagent } from "./subagents/policy.js";
import { runRefundSubagent } from "./subagents/refund.js";

function buildDelegateTools(claude: ClaudeClient, mcp: MercuryMcpConnection): LocalToolSpec[] {
  return [
    {
      name: "delegate_to_identity_subagent",
      description:
        "Delegates to the Identity subagent: looks up and, if a verification value is supplied, " +
        "verifies the customer's identity. Returns a structured IdentityFinding.",
      input_schema: {
        type: "object",
        properties: {
          customerId: { type: "string" },
          verificationValue: { type: "string", description: "Verification value supplied by the customer, if any" },
        },
        required: ["customerId"],
      },
      sideEffecting: true,
      handler: async (input, context) => {
        const finding = await runIdentitySubagent(claude, mcp, context, {
          customerId: String(input.customerId),
          verificationValue: input.verificationValue ? String(input.verificationValue) : undefined,
        });
        if (!finding) {
          return fail(
            "DEPENDENCY",
            "IDENTITY_SUBAGENT_DID_NOT_CONVERGE",
            "The Identity subagent hit its iteration/duplicate-call safety valve without reporting a finding.",
            true
          );
        }
        return ok({ finding });
      },
    },
    {
      name: "delegate_to_order_subagent",
      description:
        "Delegates to the Order subagent: looks up order status, line items, delivery info, and " +
        "payment/refund history. Read-only. Returns a structured OrderFinding.",
      input_schema: {
        type: "object",
        properties: { orderId: { type: "string" }, customerId: { type: "string" } },
        required: ["orderId", "customerId"],
      },
      sideEffecting: false,
      handler: async (input, context) => {
        const finding = await runOrderSubagent(claude, mcp, context, {
          orderId: String(input.orderId),
          customerId: String(input.customerId),
        });
        if (!finding) {
          return fail(
            "DEPENDENCY",
            "ORDER_SUBAGENT_DID_NOT_CONVERGE",
            "The Order subagent hit its iteration/duplicate-call safety valve without reporting a finding.",
            true
          );
        }
        return ok({ finding });
      },
    },
    {
      name: "delegate_to_policy_subagent",
      description:
        "Delegates to the Policy subagent: evaluates applicable return/refund policy for a " +
        "region+SKU as of a date, including conflict detection. Read-only. Returns a PolicyFinding.",
      input_schema: {
        type: "object",
        properties: {
          region: { type: "string" },
          sku: { type: "string" },
          issueType: { type: "string", enum: ["return", "refund_request"] },
          deliveryDate: { type: ["string", "null"] },
          asOfDate: { type: "string" },
        },
        required: ["region", "sku", "issueType", "deliveryDate", "asOfDate"],
      },
      sideEffecting: false,
      handler: async (input, context) => {
        const finding = await runPolicySubagent(claude, mcp, context, {
          region: String(input.region),
          sku: String(input.sku),
          issueType: input.issueType as "return" | "refund_request",
          deliveryDate: (input.deliveryDate as string | null) ?? null,
          asOfDate: String(input.asOfDate),
        });
        if (!finding) {
          return fail(
            "DEPENDENCY",
            "POLICY_SUBAGENT_DID_NOT_CONVERGE",
            "The Policy subagent hit its iteration/duplicate-call safety valve without reporting a finding.",
            true
          );
        }
        return ok({ finding });
      },
    },
    {
      name: "delegate_to_refund_subagent",
      description:
        "Delegates to the Refund subagent: validates amount/currency/balance against the policy " +
        "decision already established, and executes the refund if and only if appropriate. Only " +
        "call this AFTER delegate_to_identity_subagent, delegate_to_order_subagent, and " +
        "delegate_to_policy_subagent have all returned. Side-effecting.",
      input_schema: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          customerId: { type: "string" },
          requestedAmount: { type: "string" },
          currency: { type: "string" },
          policyDecision: { type: "string", enum: ["eligible", "ineligible", "partially_eligible", "undetermined"] },
          policyConfidence: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string" },
        },
        required: ["orderId", "customerId", "requestedAmount", "currency", "policyDecision", "policyConfidence", "reason"],
      },
      sideEffecting: true,
      handler: async (input, context) => {
        const finding = await runRefundSubagent(claude, mcp, context, {
          orderId: String(input.orderId),
          customerId: String(input.customerId),
          requestedAmount: String(input.requestedAmount),
          currency: String(input.currency),
          policyDecision: input.policyDecision as "eligible" | "ineligible" | "partially_eligible" | "undetermined",
          policyConfidence: input.policyConfidence as "high" | "medium" | "low",
          reason: String(input.reason),
        });
        if (!finding) {
          return fail(
            "DEPENDENCY",
            "REFUND_SUBAGENT_DID_NOT_CONVERGE",
            "The Refund subagent hit its iteration/duplicate-call safety valve without reporting a finding.",
            true
          );
        }
        return ok({ finding });
      },
    },
  ];
}

export async function runCoordinator(options: {
  claude: ClaudeClient;
  mcp: MercuryMcpConnection;
  caseId: string;
  traceId: string;
  initialUserMessage: string;
}): Promise<LoopResult> {
  const context = new CaseContext(options.caseId, options.traceId);
  const delegateTools = buildDelegateTools(options.claude, options.mcp);
  const loop = new AgentLoop(options.claude, options.mcp, COORDINATOR_SYSTEM_PROMPT, context, delegateTools);
  return loop.run(options.initialUserMessage);
}
