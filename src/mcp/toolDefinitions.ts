/**
 * Purpose-specific MCP tool definitions for Mercury Market.
 *
 * Each tool is deliberately narrow: one action, one typed input, one typed
 * output, one documented failure mode set. There is no generic "run SQL" or
 * "make an HTTP request" escape hatch — every capability the agent has is
 * enumerated here. Read tools (get_*, lookup_order, evaluate_policy,
 * get_case_history) never mutate backend state; side-effecting tools
 * (verify_customer_identity, create_return, process_refund,
 * record_case_event, escalate_to_human) are marked `sideEffecting: true` so
 * the agent loop and hooks (src/agent/hooks.ts) can apply stricter rules to
 * them (no blind retries, identity/threshold checks, no execution from a
 * forked/read-only session).
 *
 * This module is the single source of truth for tool shape: both the real
 * MCP server (src/mcp/server.ts) and the in-process agent tool executor
 * register tools from this list, so the two can never drift apart.
 */

import { z, type ZodRawShape } from "zod";
import {
  toolResultShape,
  EscalationPacketSchema,
  ResolutionSchema,
  CaseFactsSchema,
  IdentityFindingSchema,
  OrderFindingSchema,
  PolicyFindingSchema,
  RefundFindingSchema,
} from "../domain/schemas.js";
import type { ToolResult } from "../domain/errors.js";

import { getCustomer } from "../mock-backends/crm.js";
import { verifyCustomerIdentity } from "../mock-backends/identity.js";
import { lookupOrder } from "../mock-backends/oms.js";
import { getPaymentHistory, processRefund } from "../mock-backends/payments.js";
import { evaluatePolicy } from "../mock-backends/policy.js";
import { createReturn } from "../mock-backends/returns.js";
import {
  getCaseHistory,
  recordCaseEvent,
  escalateToHuman,
  recordResolution,
  recordCaseFacts,
} from "../mock-backends/caseManagement.js";

export interface ToolContext {
  traceId: string;
  /** True inside a forked investigation session; side-effecting tools must refuse to run. */
  readOnlySession: boolean;
}

export interface ToolSpec<Input = any, Output extends object = any> {
  name: string;
  title: string;
  description: string;
  /** Explicit usage boundary shown to both Claude (in the description) and engineers (in docs). */
  boundaries: string;
  sideEffecting: boolean;
  inputShape: ZodRawShape;
  outputShape: ZodRawShape;
  examples: string[];
  handler: (input: Input, ctx: ToolContext) => Promise<ToolResult<Output>>;
}

function forkGuard(ctx: ToolContext): ToolResult<never> | null {
  if (ctx.readOnlySession) {
    return {
      success: false,
      error: {
        errorCode: "SIDE_EFFECT_IN_READ_ONLY_SESSION",
        errorCategory: "ACCESS",
        message:
          "This is a forked, read-only investigation session. Side-effecting tools (identity " +
          "verification, returns, refunds, escalation writes) are disabled here by construction.",
        isRetryable: false,
      },
    };
  }
  return null;
}

export const toolSpecs: ToolSpec[] = [
  {
    name: "get_customer",
    title: "Get Customer",
    description:
      "Look up a customer's CRM profile by customerId: name, masked email, region, default " +
      "currency, identity status, and account flags (e.g. fraud review). Read-only.",
    boundaries:
      "Requires an exact customerId (no name/email search — this is not a customer search tool). " +
      "Does not expose unmasked contact details or payment instruments.",
    sideEffecting: false,
    inputShape: { customerId: z.string().min(1).describe("Mercury Market customer id, e.g. \"cust_001\"") },
    outputShape: toolResultShape({
      customer: z
        .object({
          customerId: z.string(),
          name: z.string(),
          maskedEmail: z.string(),
          region: z.string(),
          defaultCurrency: z.string(),
          identityStatus: z.enum(["unverified", "verified", "locked"]),
          accountFlags: z.array(z.string()),
        })
        .optional(),
    }),
    examples: [
      'get_customer({ customerId: "cust_001" }) -> { success: true, customer: { identityStatus: "unverified", ... } }',
    ],
    handler: async (input: { customerId: string }) => getCustomer(input.customerId),
  },
  {
    name: "verify_customer_identity",
    title: "Verify Customer Identity",
    description:
      "Attempts to verify a customer's identity using a knowledge-based verification value " +
      "(e.g. billing zip/postcode on file). On success, transitions the customer's identityStatus " +
      "to \"verified\" for the rest of the session. This is the ONLY way identityStatus becomes " +
      "\"verified\" — it cannot be set by assertion elsewhere.",
    boundaries:
      "Must be called, and must succeed, before any customer-specific order, return, or refund " +
      "operation — this is enforced programmatically by a pre-tool-call hook, not by prompting. " +
      "Locked accounts (fraud review) always fail verification and must be escalated.",
    sideEffecting: true,
    inputShape: {
      customerId: z.string().min(1),
      verificationValue: z.string().min(1).describe("Value supplied by the customer, e.g. billing zip/postcode"),
    },
    outputShape: toolResultShape({
      identityStatus: z.enum(["unverified", "verified", "locked"]).optional(),
      verified: z.boolean().optional(),
    }),
    examples: [
      'verify_customer_identity({ customerId: "cust_001", verificationValue: "94107" }) -> { success: true, verified: true, identityStatus: "verified" }',
      'verify_customer_identity({ customerId: "cust_011", verificationValue: "10005" }) -> { success: false, error: { errorCode: "ACCOUNT_LOCKED", errorCategory: "ACCESS", isRetryable: false } }',
    ],
    handler: async (input: { customerId: string; verificationValue: string }, ctx) => {
      const blocked = forkGuard(ctx);
      if (blocked) return blocked;
      return verifyCustomerIdentity(input.customerId, input.verificationValue);
    },
  },
  {
    name: "lookup_order",
    title: "Lookup Order",
    description:
      "Retrieves order status, line items (SKU, description, quantity, unit price, line total), " +
      "delivery information, and amount paid for a single order. Read-only.",
    boundaries:
      "Requires requestingCustomerId and verifies the order belongs to that customer, returning " +
      "an ACCESS error otherwise (never silently returns another customer's order).",
    sideEffecting: false,
    inputShape: {
      orderId: z.string().min(1),
      requestingCustomerId: z.string().min(1),
    },
    outputShape: toolResultShape({
      order: z
        .object({
          orderId: z.string(),
          customerId: z.string(),
          region: z.string(),
          currency: z.string(),
          status: z.enum(["delivered", "shipped", "processing", "cancelled"]),
          orderDate: z.string(),
          deliveryDate: z.string().nullable(),
          lineItems: z.array(
            z.object({
              sku: z.string(),
              description: z.string(),
              quantity: z.number(),
              unitPrice: z.string(),
              lineTotal: z.string(),
            })
          ),
          amountPaid: z.string(),
        })
        .optional(),
    }),
    examples: [
      'lookup_order({ orderId: "ord_1001", requestingCustomerId: "cust_001" }) -> { success: true, order: { status: "delivered", ... } }',
      'lookup_order({ orderId: "ord_9999", requestingCustomerId: "cust_001" }) -> { success: false, error: { errorCode: "ORDER_NOT_FOUND", errorCategory: "NOT_FOUND", isRetryable: false } }',
    ],
    handler: async (input: { orderId: string; requestingCustomerId: string }) =>
      lookupOrder(input.orderId, input.requestingCustomerId),
  },
  {
    name: "get_payment_history",
    title: "Get Payment History",
    description:
      "Returns the list of prior refunds issued against an order plus the remaining refundable " +
      "balance (amount paid minus refunds already issued). An empty `refunds` array with " +
      "success:true means the order genuinely has no prior refunds — it is NOT an error.",
    boundaries: "Read-only. Scoped to a single orderId; cannot list all payments platform-wide.",
    sideEffecting: false,
    inputShape: { orderId: z.string().min(1) },
    outputShape: toolResultShape({
      refunds: z
        .array(z.object({ transactionId: z.string(), amount: z.string(), currency: z.string(), createdAt: z.string() }))
        .optional(),
      remainingRefundableAmount: z.string().optional(),
      currency: z.string().optional(),
    }),
    examples: [
      'get_payment_history({ orderId: "ord_1006" }) -> { success: true, refunds: [], remainingRefundableAmount: "32.00", currency: "USD" }',
    ],
    handler: async (input: { orderId: string }) => getPaymentHistory(input.orderId),
  },
  {
    name: "evaluate_policy",
    title: "Evaluate Policy",
    description:
      "Interprets applicable return/refund policy for a given region + SKU as of a given date. " +
      "Returns a decision (eligible/ineligible/partially_eligible/undetermined), a confidence " +
      "classification (high/medium/low), full policy citations with version/effective-date " +
      "provenance, and any detected conflicts between region-wide and SKU-specific policy " +
      "documents. Never guesses a winner between two conflicting, unresolved policies — it " +
      "returns decision:\"undetermined\", confidence:\"low\", and both citations.",
    boundaries:
      "Read-only. Does not compute a dollar amount (combine with order line items for that). " +
      "Only supports issueType \"return\" and \"refund_request\".",
    sideEffecting: false,
    inputShape: {
      region: z.string().min(1),
      sku: z.string().min(1),
      issueType: z.enum(["return", "refund_request"]),
      deliveryDate: z.string().nullable(),
      asOfDate: z.string().min(1).describe("Date to evaluate policy effectiveness against, YYYY-MM-DD"),
    },
    outputShape: toolResultShape({
      decision: z.enum(["eligible", "ineligible", "partially_eligible", "undetermined"]).optional(),
      confidence: z.enum(["high", "medium", "low"]).optional(),
      withinReturnWindow: z.boolean().nullable().optional(),
      citations: z.array(z.record(z.string(), z.unknown())).optional(),
      conflicts: z.array(z.object({ policyA: z.string(), policyB: z.string(), description: z.string() })).optional(),
      ambiguities: z.array(z.string()).optional(),
    }),
    examples: [
      'evaluate_policy({ region: "US", sku: "HOME-MUG-01", issueType: "return", deliveryDate: "2026-07-24", asOfDate: "2026-08-01" }) -> { success: true, decision: "eligible", confidence: "high", citations: [{ policyId: "POL-RETURN-GLOBAL", ... }] }',
      'evaluate_policy({ region: "EU", sku: "ELECTRONICS-DRONE", issueType: "return", deliveryDate: "2026-07-30", asOfDate: "2026-08-02" }) -> { success: true, decision: "undetermined", confidence: "low", conflicts: [{ policyA: "POL-DRONE-HAZMAT", policyB: "POL-RETURN-EU", ... }] }',
    ],
    handler: async (
      input: { region: string; sku: string; issueType: "return" | "refund_request"; deliveryDate: string | null; asOfDate: string },
      ctx
    ) => evaluatePolicy({ ...input, traceId: ctx.traceId }),
  },
  {
    name: "create_return",
    title: "Create Return",
    description:
      "Authorizes a return against a delivered order for one or more line items, producing a " +
      "returnId. Does not move money — a subsequent process_refund call executes the financial " +
      "side once policy eligibility and amount have been validated.",
    boundaries:
      "Requires the order to be in \"delivered\" status and requested SKUs/quantities to exist on " +
      "the order. Should only be called after evaluate_policy indicates eligibility.",
    sideEffecting: true,
    inputShape: {
      orderId: z.string().min(1),
      customerId: z.string().min(1),
      lineItems: z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().positive() })).min(1),
      reason: z.string().min(1),
    },
    outputShape: toolResultShape({
      returnRecord: z
        .object({
          returnId: z.string(),
          orderId: z.string(),
          customerId: z.string(),
          status: z.literal("authorized"),
          createdAt: z.string(),
        })
        .optional(),
    }),
    examples: [
      'create_return({ orderId: "ord_1001", customerId: "cust_001", lineItems: [{ sku: "HOME-MUG-01", quantity: 1 }], reason: "changed mind" }) -> { success: true, returnRecord: { returnId: "ret_5001", status: "authorized" } }',
    ],
    handler: async (
      input: { orderId: string; customerId: string; lineItems: { sku: string; quantity: number }[]; reason: string },
      ctx
    ) => {
      const blocked = forkGuard(ctx);
      if (blocked) return blocked;
      return createReturn(input.orderId, input.customerId, input.lineItems, input.reason);
    },
  },
  {
    name: "process_refund",
    title: "Process Refund",
    description:
      "Executes a refund against an order's original payment method. REQUIRES a caller-supplied " +
      "idempotencyKey: replaying the same idempotencyKey always returns the original transaction " +
      "(never creates a duplicate refund). Validates currency match and that the amount does not " +
      "exceed the order's remaining refundable balance before touching the payment gateway.",
    boundaries:
      "The single money-moving tool in this system. Subject to programmatic threshold enforcement " +
      "(src/agent/hooks.ts) independent of anything Claude is told in a prompt: verified identity " +
      "is required, and amounts at/above MERCURY_MANDATORY_ESCALATION_LIMIT are blocked from " +
      "autonomous execution regardless of model confidence. Disabled entirely in forked sessions.",
    sideEffecting: true,
    inputShape: {
      orderId: z.string().min(1),
      customerId: z.string().min(1),
      amount: z.string().regex(/^-?\d+(\.\d+)?$/),
      currency: z.string().length(3),
      reason: z.string().min(1),
      idempotencyKey: z.string().min(1),
    },
    outputShape: toolResultShape({
      transactionId: z.string().optional(),
      amount: z.string().optional(),
      currency: z.string().optional(),
      replayed: z.boolean().optional(),
      createdAt: z.string().optional(),
    }),
    examples: [
      'process_refund({ orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "return accepted", idempotencyKey: "case-77-refund-1" }) -> { success: true, transactionId: "txn_9101", replayed: false }',
      'process_refund({ ...same idempotencyKey as above }) -> { success: true, transactionId: "txn_9101", replayed: true } // no duplicate created',
    ],
    handler: async (
      input: { orderId: string; customerId: string; amount: string; currency: string; reason: string; idempotencyKey: string },
      ctx
    ) => {
      const blocked = forkGuard(ctx);
      if (blocked) return blocked;
      return processRefund(input);
    },
  },
  {
    name: "get_case_history",
    title: "Get Case History",
    description: "Returns the chronological event log recorded for a case (via record_case_event). Read-only.",
    boundaries: "Scoped to a single caseId.",
    sideEffecting: false,
    inputShape: { caseId: z.string().min(1) },
    outputShape: toolResultShape({
      events: z
        .array(
          z.object({ caseId: z.string(), eventType: z.string(), summary: z.string(), actor: z.string(), createdAt: z.string() })
        )
        .optional(),
    }),
    examples: ['get_case_history({ caseId: "case_001" }) -> { success: true, events: [] } // no history yet is valid'],
    handler: async (input: { caseId: string }) => getCaseHistory(input.caseId),
  },
  {
    name: "record_case_event",
    title: "Record Case Event",
    description:
      "Appends an audit-trail event to a case (e.g. \"identity_verified\", \"policy_evaluated\", " +
      "\"refund_processed\"). Used to build the audit trail independent of what is summarized back " +
      "to Claude's context.",
    boundaries: "Append-only; there is no update/delete event tool by design (audit integrity).",
    sideEffecting: true,
    inputShape: {
      caseId: z.string().min(1),
      eventType: z.string().min(1),
      summary: z.string().min(1),
      actor: z.string().min(1),
    },
    outputShape: toolResultShape({
      event: z
        .object({ caseId: z.string(), eventType: z.string(), summary: z.string(), actor: z.string(), createdAt: z.string() })
        .optional(),
    }),
    examples: [
      'record_case_event({ caseId: "case_001", eventType: "identity_verified", summary: "Verified via zip code match", actor: "identity_subagent" })',
    ],
    handler: async (input: { caseId: string; eventType: string; summary: string; actor: string }) =>
      recordCaseEvent(input.caseId, input.eventType, input.summary, input.actor),
  },
  {
    name: "escalate_to_human",
    title: "Escalate To Human",
    description:
      "Files a structured, auditor-ready escalation packet for human review and stores it in the " +
      "case-management system. This is the terminal action for any case the coordinator determines " +
      "cannot be safely resolved autonomously (ambiguous policy, high value, unverified/locked " +
      "identity, retry exhaustion, missing provenance).",
    boundaries:
      "Always allowed, including from forked investigation sessions (escalating is never the unsafe " +
      "action). The input is the full EscalationPacket — every consequential claim inside must cite " +
      "a Provenance entry from an actual tool call.",
    sideEffecting: true,
    inputShape: EscalationPacketSchema.shape,
    outputShape: toolResultShape({ escalationId: z.string().optional() }),
    examples: [
      'escalate_to_human({ caseId: "case_003", escalationReason: "Refund amount $799.99 exceeds autonomous limit", ... }) -> { success: true, escalationId: "esc_0001" }',
    ],
    handler: async (input) => escalateToHuman(input as any),
  },
  {
    name: "record_case_facts",
    title: "Record Case Facts",
    description:
      "Structured-output control tool (not a backend action): submits the coordinator's current " +
      "understanding of the case as a schema-validated CaseFacts object, replacing the previous " +
      "snapshot for this caseId. Call this whenever material new facts are established (identity " +
      "verified, order looked up, amount clarified) so the case's structured state stays " +
      "authoritative instead of being re-derived from prose.",
    boundaries: "Never terminates the loop by itself; the coordinator keeps reasoning afterward.",
    sideEffecting: false,
    inputShape: CaseFactsSchema.shape,
    outputShape: toolResultShape({ acknowledged: z.boolean().optional() }),
    examples: [],
    handler: async (input) => recordCaseFacts(input as any),
  },
  {
    name: "resolve_case",
    title: "Resolve Case (Autonomous)",
    description:
      "Structured-output, TERMINAL control tool: declares that the case is resolved autonomously " +
      "and ends the agentic loop. Every field is cross-checked against what was actually retrieved " +
      "this case (refundTransactionId must match a real process_refund result, policyCitations must " +
      "match real evaluate_policy citations) before being accepted — call it only once eligibility, " +
      "amount, currency, and identity have all been established and, if applicable, process_refund " +
      "has already succeeded.",
    boundaries:
      "MUST NOT be used for cases requiring escalation (use escalate_to_human instead). Rejected if " +
      "the amount is at/above the mandatory escalation threshold.",
    sideEffecting: false,
    inputShape: ResolutionSchema.shape,
    outputShape: toolResultShape({ acknowledged: z.boolean().optional() }),
    examples: [
      'resolve_case({ caseId: "case_001", outcome: "resolved_autonomously", refundTransactionId: "txn_9101", refundAmount: { amount: "45.00", currency: "USD" }, policyCitations: [...], ... })',
    ],
    handler: async (input) => recordResolution(input as any),
  },
  {
    name: "submit_identity_finding",
    title: "Submit Identity Finding",
    description:
      "Structured-output, TERMINAL tool for the Identity subagent: reports the customer's " +
      "verification outcome back to the coordinator and ends the Identity subagent's own bounded loop.",
    boundaries: "Only used by the Identity subagent; the coordinator never calls this directly.",
    sideEffecting: false,
    inputShape: IdentityFindingSchema.shape,
    outputShape: toolResultShape({ acknowledged: z.boolean().optional() }),
    examples: [],
    handler: async () => ({ success: true, acknowledged: true }),
  },
  {
    name: "submit_order_finding",
    title: "Submit Order Finding",
    description:
      "Structured-output, TERMINAL tool for the Order subagent: reports order status, line items, " +
      "delivery info, and ownership match back to the coordinator and ends the Order subagent's loop.",
    boundaries: "Only used by the Order subagent.",
    sideEffecting: false,
    inputShape: OrderFindingSchema.shape,
    outputShape: toolResultShape({ acknowledged: z.boolean().optional() }),
    examples: [],
    handler: async () => ({ success: true, acknowledged: true }),
  },
  {
    name: "submit_policy_finding",
    title: "Submit Policy Finding",
    description:
      "Structured-output, TERMINAL tool for the Policy subagent: reports the policy decision, " +
      "confidence, citations, and any conflicts back to the coordinator and ends the Policy subagent's loop.",
    boundaries: "Only used by the Policy subagent.",
    sideEffecting: false,
    inputShape: PolicyFindingSchema.shape,
    outputShape: toolResultShape({ acknowledged: z.boolean().optional() }),
    examples: [],
    handler: async () => ({ success: true, acknowledged: true }),
  },
  {
    name: "submit_refund_finding",
    title: "Submit Refund Finding",
    description:
      "Structured-output, TERMINAL tool for the Refund subagent: reports whether a refund was " +
      "executed (autonomous) or must be escalated, and ends the Refund subagent's loop.",
    boundaries: "Only used by the Refund subagent.",
    sideEffecting: false,
    inputShape: RefundFindingSchema.shape,
    outputShape: toolResultShape({ acknowledged: z.boolean().optional() }),
    examples: [],
    handler: async () => ({ success: true, acknowledged: true }),
  },
];

export const TERMINAL_TOOL_NAMES = new Set(["resolve_case", "escalate_to_human"]);
export const SUBAGENT_FINDING_TOOL_NAMES = new Set([
  "submit_identity_finding",
  "submit_order_finding",
  "submit_policy_finding",
  "submit_refund_finding",
]);

export function getToolSpec(name: string): ToolSpec | undefined {
  return toolSpecs.find((t) => t.name === name);
}
