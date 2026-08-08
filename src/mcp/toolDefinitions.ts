/**
 * Purpose-specific MCP tool definitions for Mercury Market Track 2.
 *
 * Every tool is one action, one typed input, one typed output, one
 * documented failure mode set — no generic SQL/HTTP escape hatch. Read tools
 * (get_*, lookup_order, evaluate_policy, get_case_history) never mutate
 * backend state. `process_refund` and `create_return` are the only two
 * customer-affecting, money-moving/order-changing tools in the system; they
 * are refused unconditionally unless the calling MCP connection is bound to
 * the `human_support_agent` role AND the input carries a matching, on-file,
 * unexpired approval (`src/mcp/authorization.ts`). No other tool, hook, or
 * prompt may grant that role — it is fixed per connection by
 * `createMercuryMcpServer`'s caller (`src/agent/mcpClient.ts` always opens
 * `advisor_agent`; only `src/approvals/execute.ts` ever opens
 * `human_support_agent`, and only for the duration of one execution call).
 *
 * This module is the single source of truth for tool shape: both the real
 * MCP server (src/mcp/server.ts) and the in-process agent tool executor
 * register tools from this list, so the two can never drift apart.
 */

import { z, type ZodRawShape } from "zod";
import { toolResultShape, EscalationPacketSchema, IdentityFindingSchema, OrderFindingSchema, PolicyFindingSchema } from "../domain/schemas.js";
import { AdvisorCaseFactsSchema } from "../domain/schemas/advisorCaseFacts.js";
import { ProposalFindingSchema } from "../domain/schemas/proposalFinding.js";
import { SuggestionPacketSchema } from "../domain/schemas/suggestionPacket.js";
import type { ToolResult } from "../domain/errors.js";
import type { Role } from "../domain/roles.js";
import { authorizeExecution, type ExecutionContextInput } from "./authorization.js";

import { getCustomer } from "../mock-backends/crm.js";
import { verifyCustomerIdentity } from "../mock-backends/identity.js";
import { lookupOrder } from "../mock-backends/oms.js";
import { getPaymentHistory, processRefund } from "../mock-backends/payments.js";
import { evaluatePolicy } from "../mock-backends/policy.js";
import { createReturn } from "../mock-backends/returns.js";
import { getCaseHistory, recordCaseEvent, recordCaseFacts } from "../mock-backends/caseManagement.js";
import { enqueueEscalation } from "../mock-backends/approvalQueue.js";
import { recordSuggestionPacket } from "../advisor/packetStore.js";

export interface ToolContext {
  traceId: string;
  /** Fixed per MCP connection — see module doc comment. Never settable via tool input. */
  callerRole: Role;
  /** True inside a forked investigation session; side-effecting tools must refuse to run. */
  readOnlySession: boolean;
  sessionId: string;
}

export interface ToolSpec<Input = any, Output extends object = any> {
  name: string;
  title: string;
  description: string;
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
          "verification, escalation writes) are disabled here by construction.",
        isRetryable: false,
      },
    };
  }
  return null;
}

const ExecutionContextShape = {
  humanActorId: z.string().min(1),
  suggestionId: z.string().min(1),
  suggestionVersion: z.number().int().positive(),
  suggestionHash: z.string().min(1),
  actionId: z.string().min(1),
  actionVersion: z.number().int().positive(),
  actionHash: z.string().min(1),
};

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
      "\"verified\" — the advisor may call this directly (inspecting/establishing verification " +
      "state is an explicitly allowed advisor action); it does not by itself authorize any " +
      "customer-affecting action, which still requires separate human approval and execution.",
    boundaries:
      "Locked accounts (fraud review) always fail verification and must be escalated. Disabled in " +
      "forked/read-only sessions.",
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
      const blockedFork = forkGuard(ctx);
      if (blockedFork) return blockedFork;
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
    boundaries: "Read-only. Scoped to a single orderId; cannot list all payments platform-wide. Never exposes full payment-instrument credentials.",
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
      "documents. Never guesses a winner between two conflicting, unresolved policies.",
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
    ],
    handler: async (
      input: { region: string; sku: string; issueType: "return" | "refund_request"; deliveryDate: string | null; asOfDate: string },
      ctx
    ) => evaluatePolicy({ ...input, traceId: ctx.traceId }),
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
      "\"suggestion_packet_submitted\"). Used to build the audit trail independent of what is " +
      "summarized back into the advisor's context.",
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
      "Files a structured, auditor-ready escalation packet into the human-review queue (spec " +
      "section 11) — a typed queue item a human_support_agent or policy_reviewer works from, not a " +
      "terminal 'case closed' record. This is the terminal action for any advisor run that " +
      "determines a case cannot be safely proposed on (ambiguous policy, unverified/locked " +
      "identity, retry exhaustion, missing provenance) — the advisor never resolves a case itself.",
    boundaries:
      "Always allowed, including from forked investigation sessions (escalating is never the unsafe " +
      "action). Every consequential claim inside the packet must cite a Provenance entry from an " +
      "actual tool call.",
    sideEffecting: true,
    inputShape: { ...EscalationPacketSchema.shape, sessionId: z.string().min(1), suggestionId: z.string().nullable() },
    outputShape: toolResultShape({ escalationId: z.string().optional() }),
    examples: [
      'escalate_to_human({ caseId: "case_003", sessionId: "sess_1", suggestionId: null, escalationReason: "Refund amount $799.99 exceeds configured risk threshold", ... }) -> { success: true, escalationId: "esc_0001" }',
    ],
    handler: async (input: any) => {
      const { sessionId, suggestionId, ...packet } = input;
      const result = await enqueueEscalation(packet, sessionId, suggestionId ?? null);
      // Only surface fields declared in outputShape — the MCP SDK validates
      // structuredContent against the registered outputSchema once a client has
      // called listTools(), and rejects any additional property (the mock
      // backend's richer `item` field is internal bookkeeping, not part of the
      // tool's documented contract).
      if (!result.success) return result;
      return { success: true, escalationId: result.escalationId };
    },
  },
  {
    name: "record_case_facts",
    title: "Record Case Facts",
    description:
      "Structured-output control tool (not a backend action): submits the advisor's Pass-1 " +
      "understanding of the case as a schema-validated AdvisorCaseFacts object (claims vs verified " +
      "facts vs interpretations vs hypotheses, contradictions, missing facts), replacing the " +
      "previous snapshot for this caseId.",
    boundaries: "Never terminates the loop by itself; the advisor keeps reasoning afterward.",
    sideEffecting: false,
    inputShape: AdvisorCaseFactsSchema.shape,
    outputShape: toolResultShape({ acknowledged: z.boolean().optional() }),
    examples: [],
    handler: async (input) => recordCaseFacts(input as any),
  },
  {
    name: "submit_identity_finding",
    title: "Submit Identity Finding",
    description:
      "Structured-output, TERMINAL tool for the Identity specialist: reports the customer's " +
      "verification outcome back to the advisor and ends the Identity specialist's own bounded loop.",
    boundaries: "Only used by the Identity specialist; the advisor coordinator never calls this directly.",
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
      "Structured-output, TERMINAL tool for the Order/Fulfillment specialist: reports order status, " +
      "line items, delivery info, and ownership match back to the advisor.",
    boundaries: "Only used by the Order specialist.",
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
      "Structured-output, TERMINAL tool for the Policy specialist: reports the policy decision, " +
      "confidence, citations, and any conflicts back to the advisor.",
    boundaries: "Only used by the Policy specialist.",
    sideEffecting: false,
    inputShape: PolicyFindingSchema.shape,
    outputShape: toolResultShape({ acknowledged: z.boolean().optional() }),
    examples: [],
    handler: async () => ({ success: true, acknowledged: true }),
  },
  {
    name: "submit_resolution_finding",
    title: "Submit Resolution Finding",
    description:
      "Structured-output, TERMINAL tool for the Resolution-proposal specialist: reports a PROPOSED " +
      "remedy (never an executed one — this specialist has no access to process_refund/create_return " +
      "at all) back to the advisor for cross-issue integration and precision review.",
    boundaries: "Only used by the Resolution-proposal specialist. Never represents money already moved.",
    sideEffecting: false,
    inputShape: ProposalFindingSchema.shape,
    outputShape: toolResultShape({ acknowledged: z.boolean().optional() }),
    examples: [],
    handler: async () => ({ success: true, acknowledged: true }),
  },
  {
    name: "submit_suggestion_packet",
    title: "Submit Suggestion Packet",
    description:
      "Structured-output, TERMINAL tool for the advisor: submits the final, integrated, precision- " +
      "reviewed SuggestionPacket for human review and ends the advisor loop. This is the ONLY way an " +
      "advisor run concludes other than escalate_to_human — there is no 'resolve_case' tool in Track " +
      "2, because the advisor never resolves a case on its own.",
    boundaries:
      "MUST NOT be submitted if src/advisor's precision-review pass produced any blocking finding — " +
      "call escalate_to_human or continue investigating instead.",
    sideEffecting: false,
    inputShape: SuggestionPacketSchema.shape,
    outputShape: toolResultShape({ acknowledged: z.boolean().optional() }),
    examples: [],
    handler: async (input) => {
      recordSuggestionPacket(input as any);
      return { success: true, acknowledged: true };
    },
  },
  {
    name: "create_return",
    title: "Create Return",
    description:
      "Authorizes a return against a delivered order for one or more line items, producing a " +
      "returnId. This is a customer-affecting, externally visible action the advisor must NEVER " +
      "call directly — it requires a `human_support_agent` connection plus a matching, on-file " +
      "approval (see module doc comment and src/mcp/authorization.ts). An advisor may only PROPOSE " +
      "this action inside a SuggestionPacket's proposedActions.",
    boundaries:
      "Requires the order to be in \"delivered\" status and requested SKUs/quantities to exist on " +
      "the order. Refused unconditionally for any connection not bound to human_support_agent.",
    sideEffecting: true,
    inputShape: {
      orderId: z.string().min(1),
      customerId: z.string().min(1),
      lineItems: z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().positive() })).min(1),
      reason: z.string().min(1),
      executionContext: z.object(ExecutionContextShape).optional(),
    },
    outputShape: toolResultShape({
      returnRecord: z
        .object({
          returnId: z.string(),
          orderId: z.string(),
          customerId: z.string(),
          lineItems: z.array(z.object({ sku: z.string(), quantity: z.number() })),
          reason: z.string(),
          status: z.literal("authorized"),
          createdAt: z.string(),
        })
        .optional(),
    }),
    examples: [
      'create_return({ orderId: "ord_1001", customerId: "cust_001", lineItems: [...], reason: "damaged in transit", executionContext: { humanActorId: "agent_42", suggestionId: "...", ... } }) -> { success: true, returnRecord: { returnId: "ret_5001", status: "authorized" } }',
    ],
    handler: async (
      input: {
        orderId: string;
        customerId: string;
        lineItems: { sku: string; quantity: number }[];
        reason: string;
        executionContext?: ExecutionContextInput;
      },
      ctx
    ) => {
      const decision = authorizeExecution("create_return", ctx.callerRole, ctx.readOnlySession, input.executionContext);
      if (!decision.allow) return { success: false, error: decision.blockedError! };
      return createReturn(input.orderId, input.customerId, input.lineItems, input.reason);
    },
  },
  {
    name: "process_refund",
    title: "Process Refund",
    description:
      "Executes a refund against an order's original payment method. This is the single money- " +
      "moving tool in the system and the advisor must NEVER call it directly — it requires a " +
      "`human_support_agent` connection plus a matching, on-file, unexpired approval referencing an " +
      "exact suggestionHash/actionHash (see module doc comment and src/mcp/authorization.ts). " +
      "REQUIRES a caller-supplied idempotencyKey: replaying the same key always returns the original " +
      "transaction, never creates a duplicate.",
    boundaries:
      "Refused unconditionally for any connection not bound to human_support_agent, independent of " +
      "anything a prompt claims. Validates currency match and that the amount does not exceed the " +
      "order's remaining refundable balance before touching the payment gateway. Disabled entirely " +
      "in forked sessions.",
    sideEffecting: true,
    inputShape: {
      orderId: z.string().min(1),
      customerId: z.string().min(1),
      amount: z.string().regex(/^-?\d+(\.\d+)?$/),
      currency: z.string().length(3),
      reason: z.string().min(1),
      idempotencyKey: z.string().min(1),
      executionContext: z.object(ExecutionContextShape).optional(),
    },
    outputShape: toolResultShape({
      transactionId: z.string().optional(),
      amount: z.string().optional(),
      currency: z.string().optional(),
      replayed: z.boolean().optional(),
      createdAt: z.string().optional(),
    }),
    examples: [
      'process_refund({ orderId: "ord_1001", customerId: "cust_001", amount: "45.00", currency: "USD", reason: "return accepted", idempotencyKey: "case-77-refund-1", executionContext: {...} }) -> { success: true, transactionId: "txn_9101", replayed: false }',
    ],
    handler: async (
      input: {
        orderId: string;
        customerId: string;
        amount: string;
        currency: string;
        reason: string;
        idempotencyKey: string;
        executionContext?: ExecutionContextInput;
      },
      ctx
    ) => {
      const decision = authorizeExecution("process_refund", ctx.callerRole, ctx.readOnlySession, input.executionContext);
      if (!decision.allow) return { success: false, error: decision.blockedError! };
      return processRefund(input);
    },
  },
];

export const TERMINAL_TOOL_NAMES = new Set(["submit_suggestion_packet", "escalate_to_human"]);
export const SUBAGENT_FINDING_TOOL_NAMES = new Set([
  "submit_identity_finding",
  "submit_order_finding",
  "submit_policy_finding",
  "submit_resolution_finding",
]);

export function getToolSpec(name: string): ToolSpec | undefined {
  return toolSpecs.find((t) => t.name === name);
}
