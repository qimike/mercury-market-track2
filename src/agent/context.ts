/**
 * Case context: the structured, persisted record of a case carried across
 * agent-loop turns (and, via SessionManager, across resumed sessions). This
 * is what gets fed back into Claude's context on the NEXT turn — never the
 * full raw tool payload. Raw results are kept in `auditTrail` for the audit
 * trail / escalation packet, but the conversation only ever sees the
 * projected, trimmed summary produced by `projectForClaude`.
 */

import type { ToolCallOutcome } from "./toolExecutor.js";
import type { HookContext } from "./hooks.js";
import type { PolicyCitation, Provenance, ConfidenceLevel } from "../domain/schemas.js";

export interface ToolFailureTally {
  toolName: string;
  errorCode: string;
  errorCategory: string;
  attempts: number;
  finalOutcome: "succeeded_after_retry" | "exhausted_retries" | "non_retryable";
}

export class CaseContext {
  identityStatus: "unverified" | "verified" | "locked" = "unverified";
  customerId: string | null = null;
  region: string | null = null;
  currency: string | null = null;
  orderId: string | null = null;
  knownRemainingRefundableAmount: { amount: string; currency: string } | null = null;
  /** From the most recent evaluate_policy result this case — the programmatic gate in
   *  hooks.ts's runRefundHooks reads these, not just what a prompt claims. */
  policyDecision: "eligible" | "ineligible" | "partially_eligible" | "undetermined" | null = null;
  policyConfidence: ConfidenceLevel | null = null;

  readonly seenPolicyCitations = new Map<string, PolicyCitation>();
  readonly seenTransactionIds = new Set<string>();
  readonly provenance: Provenance[] = [];
  readonly toolFailures: ToolFailureTally[] = [];
  readonly actionsTaken: string[] = [];
  readonly openQuestions: string[] = [];
  readonly auditTrail: ToolCallOutcome[] = [];

  escalationStatus: "none" | "escalated" | "resolved" = "none";
  escalationId: string | null = null;
  resolutionOutcome: "resolved_autonomously" | null = null;

  constructor(
    readonly caseId: string,
    readonly traceId: string
  ) {}

  toHookContext(): HookContext {
    return {
      caseId: this.caseId,
      identityStatus: this.identityStatus,
      knownRemainingRefundableAmount: this.knownRemainingRefundableAmount ?? undefined,
      caseCurrency: this.currency ?? undefined,
      policyDecision: this.policyDecision ?? undefined,
      policyConfidence: this.policyConfidence ?? undefined,
    };
  }

  /** Updates structured state from a completed tool call and records its provenance. */
  ingest(outcome: ToolCallOutcome, toolCallId: string): void {
    this.auditTrail.push(outcome);

    if (!outcome.result.success) {
      if (!outcome.blockedByHook) {
        this.toolFailures.push({
          toolName: outcome.toolName,
          errorCode: outcome.result.error.errorCode,
          errorCategory: outcome.result.error.errorCategory,
          attempts: outcome.attempts,
          finalOutcome: outcome.result.error.isRetryable ? "exhausted_retries" : "non_retryable",
        });
      }
      return;
    }

    if (outcome.attempts > 1) {
      this.toolFailures.push({
        toolName: outcome.toolName,
        errorCode: "RECOVERED",
        errorCategory: "TRANSIENT",
        attempts: outcome.attempts,
        finalOutcome: "succeeded_after_retry",
      });
    }

    const retrievedAt = new Date().toISOString();
    const data = outcome.result as Record<string, unknown>;

    switch (outcome.toolName) {
      case "get_customer": {
        const customer = data.customer as { customerId: string; region: string; defaultCurrency: string; identityStatus: CaseContext["identityStatus"] } | undefined;
        if (customer) {
          this.customerId = customer.customerId;
          this.region ??= customer.region;
          this.currency ??= customer.defaultCurrency;
          this.identityStatus = customer.identityStatus;
        }
        break;
      }
      case "verify_customer_identity": {
        const status = data.identityStatus as CaseContext["identityStatus"] | undefined;
        if (status) this.identityStatus = status;
        this.actionsTaken.push(
          data.verified ? "Customer identity verified." : "Customer identity verification attempted and failed."
        );
        break;
      }
      case "lookup_order": {
        const order = data.order as { orderId: string; region: string; currency: string } | undefined;
        if (order) {
          this.orderId = order.orderId;
          this.region = order.region;
          this.currency = order.currency;
        }
        break;
      }
      case "get_payment_history": {
        if (typeof data.remainingRefundableAmount === "string" && typeof data.currency === "string") {
          this.knownRemainingRefundableAmount = { amount: data.remainingRefundableAmount, currency: data.currency };
        }
        break;
      }
      case "evaluate_policy": {
        const citations = (data.citations as PolicyCitation[] | undefined) ?? [];
        for (const citation of citations) {
          this.seenPolicyCitations.set(citation.policyId, citation);
          this.provenance.push(citation.provenance);
        }
        // Drives the programmatic refund gate in hooks.ts's runRefundHooks —
        // NOT just documented in a prompt. The most recently evaluated policy
        // for this case is what gates process_refund/resolve_case.
        if (typeof data.decision === "string") {
          this.policyDecision = data.decision as CaseContext["policyDecision"];
        }
        if (typeof data.confidence === "string") {
          this.policyConfidence = data.confidence as CaseContext["policyConfidence"];
        }
        break;
      }
      case "create_return": {
        const record = data.returnRecord as { returnId: string } | undefined;
        if (record) this.actionsTaken.push(`Return authorized: ${record.returnId}.`);
        break;
      }
      case "process_refund": {
        if (typeof data.transactionId === "string") {
          this.seenTransactionIds.add(data.transactionId);
          this.actionsTaken.push(
            `Refund ${data.replayed ? "replayed (idempotent)" : "processed"}: ${data.transactionId} for ${data.amount} ${data.currency}.`
          );
        }
        break;
      }
      // NOTE: escalate_to_human/resolve_case deliberately do NOT flip
      // escalationStatus/resolutionOutcome here. Both are terminal, schema-
      // validated-but-not-yet-semantically-validated at this point in the
      // pipeline (see loop.ts's handleTerminalToolUse) — the caller sets
      // status explicitly only once semantic validation has also passed, so
      // a call that fails semantic validation and is later corrected on
      // retry (or exhausts retries and triggers the fail-safe path) never
      // gets treated as already resolved/escalated.
      case "escalate_to_human":
      case "resolve_case":
        break;
      default:
        break;
    }

    this.provenance.push({
      sourceType: "mcp_tool",
      sourceId: outcome.toolName,
      toolName: outcome.toolName,
      toolCallId,
      retrievedAt,
      traceId: this.traceId,
    });
  }

  /**
   * Trims a raw tool result down to the fields future reasoning actually
   * needs, instead of re-injecting the full payload into Claude's context on
   * every subsequent turn. The full result stays in `auditTrail`.
   */
  projectForClaude(toolName: string, result: Record<string, unknown>): Record<string, unknown> {
    if (!result.success) return result;
    switch (toolName) {
      case "evaluate_policy": {
        const citations = (result.citations as PolicyCitation[] | undefined) ?? [];
        return {
          success: true,
          decision: result.decision,
          confidence: result.confidence,
          withinReturnWindow: result.withinReturnWindow,
          citationIds: citations.map((c) => `${c.policyId}@v${c.version}`),
          conflicts: result.conflicts,
          ambiguities: result.ambiguities,
        };
      }
      case "lookup_order": {
        const order = result.order as Record<string, unknown> | undefined;
        return { success: true, order };
      }
      default:
        return result;
    }
  }
}
