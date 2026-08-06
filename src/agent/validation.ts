/**
 * Semantic validation beyond what JSON Schema can express: cross-field sums,
 * currency matches, and — critically — that every citation/transaction id a
 * structured output claims was actually retrieved this case, not fabricated.
 * Schema validation (shape, types, enums) already happened at the MCP layer
 * before this runs; this module is the second, semantic gate described in
 * spec section 12.
 */

import type { Resolution, EscalationPacket, CaseFacts } from "../domain/schemas.js";
import type { CaseContext } from "./context.js";
import { parseMoney, compareMoney, sumMoney, formatMoney } from "../domain/money.js";
import { config } from "../domain/config.js";

export interface FieldError {
  path: string;
  message: string;
}

export type SemanticValidationResult = { valid: true } | { valid: false; errors: FieldError[] };

function citationsAreTraceable(
  citations: Array<{ policyId: string; version: string }>,
  ctx: CaseContext,
  pathPrefix: string
): FieldError[] {
  const errors: FieldError[] = [];
  citations.forEach((citation, i) => {
    const seen = ctx.seenPolicyCitations.get(citation.policyId);
    if (!seen) {
      errors.push({
        path: `${pathPrefix}[${i}].policyId`,
        message: `Policy citation "${citation.policyId}" was never returned by evaluate_policy this case — cannot cite it.`,
      });
    } else if (seen.version !== citation.version) {
      errors.push({
        path: `${pathPrefix}[${i}].version`,
        message: `Policy "${citation.policyId}" was retrieved at version "${seen.version}", not "${citation.version}".`,
      });
    }
  });
  return errors;
}

export function validateResolution(resolution: Resolution, ctx: CaseContext): SemanticValidationResult {
  const errors: FieldError[] = [];

  if (ctx.identityStatus !== "verified") {
    errors.push({ path: "outcome", message: "Cannot resolve_case autonomously without a verified identity." });
  }

  errors.push(...citationsAreTraceable(resolution.policyCitations, ctx, "policyCitations"));

  if (resolution.refundAmount) {
    const parsed = parseMoney(resolution.refundAmount.amount, resolution.refundAmount.currency);
    if (parsed.ok) {
      const limit = config.mandatoryEscalationLimit(parsed.value.currency);
      if (compareMoney(parsed.value, limit) >= 0) {
        errors.push({
          path: "refundAmount",
          message: `Refund amount ${resolution.refundAmount.amount} ${resolution.refundAmount.currency} is at/above ` +
            `the mandatory escalation limit and cannot be part of an autonomous resolution.`,
        });
      }
    }
    // Defense in depth: process_refund's own hook (hooks.ts's runRefundHooks) already
    // requires decision eligible/partially_eligible at confidence "high" before a refund
    // can execute, but a resolve_case claiming a refund is re-checked here too.
    const eligibleDecisions = new Set(["eligible", "partially_eligible"]);
    if (!ctx.policyDecision || !eligibleDecisions.has(ctx.policyDecision) || ctx.policyConfidence !== "high") {
      errors.push({
        path: "refundAmount",
        message:
          `A refundAmount is claimed but this case's policy decision/confidence ` +
          `(${ctx.policyDecision ?? "none"}/${ctx.policyConfidence ?? "none"}) does not support an ` +
          `autonomous refund.`,
      });
    }
    if (!resolution.refundTransactionId) {
      errors.push({
        path: "refundTransactionId",
        message: "refundAmount was provided but refundTransactionId is null — a refund must have executed first.",
      });
    } else if (!ctx.seenTransactionIds.has(resolution.refundTransactionId)) {
      errors.push({
        path: "refundTransactionId",
        message: `Transaction "${resolution.refundTransactionId}" does not match any process_refund result seen this case.`,
      });
    }
  } else if (resolution.refundTransactionId) {
    errors.push({
      path: "refundAmount",
      message: "refundTransactionId was provided but refundAmount is null.",
    });
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

export function validateEscalationPacket(packet: EscalationPacket, ctx: CaseContext): SemanticValidationResult {
  const errors: FieldError[] = [];

  errors.push(...citationsAreTraceable(packet.policyCitations, ctx, "policyCitations"));

  if (packet.policyCitations.length > 0 && packet.provenance.length === 0) {
    errors.push({
      path: "provenance",
      message: "Policy citations are present but provenance is empty — every citation needs a provenance entry.",
    });
  }

  if (packet.requestedAmount && packet.eligibleAmount) {
    const requested = parseMoney(packet.requestedAmount.amount, packet.requestedAmount.currency);
    const eligible = parseMoney(packet.eligibleAmount.amount, packet.eligibleAmount.currency);
    if (requested.ok && eligible.ok && requested.value.currency !== eligible.value.currency) {
      errors.push({
        path: "eligibleAmount.currency",
        message: `eligibleAmount currency "${eligible.value.currency}" does not match requestedAmount currency "${requested.value.currency}".`,
      });
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Validates CaseFacts submitted via record_case_facts. Implements the spec's
 * named example invariant: `line_item_refund_sum == requested_refund_total`
 * — when a requestedAmount and line items are both present, the line items'
 * total must equal the requested amount (a customer can't be recorded as
 * requesting $80 while the line items on the case only sum to $45).
 */
export function validateCaseFacts(facts: CaseFacts): SemanticValidationResult {
  const errors: FieldError[] = [];

  if (facts.requestedAmount && facts.lineItems.length > 0) {
    const currency = facts.requestedAmount.currency;
    const sameCurrencyItems = facts.lineItems.filter((li) => li.lineTotal.currency === currency);
    if (sameCurrencyItems.length !== facts.lineItems.length) {
      errors.push({
        path: "lineItems",
        message: `All line items must be in the case currency "${currency}" to validate against requestedAmount.`,
      });
    } else {
      const lineItemSum = sumMoney(
        sameCurrencyItems.map((li) => ({ currency: li.lineTotal.currency, minorUnits: parseMoneyOrZero(li.lineTotal) })),
        currency
      );
      const requested = parseMoney(facts.requestedAmount.amount, facts.requestedAmount.currency);
      if (requested.ok && formatMoney(lineItemSum) !== formatMoney(requested.value)) {
        errors.push({
          path: "requestedAmount",
          message:
            `requestedAmount (${facts.requestedAmount.amount} ${currency}) does not equal the sum of ` +
            `lineItems' lineTotal (${formatMoney(lineItemSum)} ${currency}).`,
        });
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function parseMoneyOrZero(m: { amount: string; currency: string }): number {
  const parsed = parseMoney(m.amount, m.currency);
  return parsed.ok ? parsed.value.minorUnits : 0;
}

/** Formats field errors into a message Claude can act on directly, per-field. */
export function formatValidationErrorsForClaude(toolName: string, errors: FieldError[]): string {
  const lines = errors.map((e) => `- ${e.path}: ${e.message}`).join("\n");
  return (
    `Validation failed for ${toolName}. Fix exactly these fields and call ${toolName} again with the ` +
    `same caseId — do not repeat any side-effecting tool calls (process_refund, create_return, ` +
    `verify_customer_identity) while correcting this output:\n${lines}`
  );
}
