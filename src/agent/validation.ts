/**
 * Semantic validation beyond what JSON Schema can express: cross-field sums,
 * currency matches, and — critically — that every citation/transaction id a
 * structured output claims was actually retrieved this case, not fabricated.
 * Schema validation (shape, types, enums) already happened at the MCP layer
 * before this runs; this module is the second, semantic gate (spec sections
 * 18-19), applied to the advisor's SuggestionPacket/EscalationPacket/
 * AdvisorCaseFacts outputs. It never authorizes execution by itself — that's
 * a separate, later revalidation in src/approvals/revalidate.ts, run again
 * immediately before `process_refund`/`create_return` actually execute.
 */

import type { EscalationPacket } from "../domain/schemas.js";
import type { SuggestionPacket, ProposedAction } from "../domain/schemas/suggestionPacket.js";
import type { AdvisorCaseFacts } from "../domain/schemas/advisorCaseFacts.js";
import type { CaseContext } from "./context.js";
import { parseMoney, compareMoney, sumMoney, formatMoney } from "../domain/money.js";

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

function moneyLikeAction(action: ProposedAction): { amount: string; currency: string; lineItems?: Array<{ lineTotal: string | { amount: string } }> } | null {
  if (action.actionType !== "propose_refund" && action.actionType !== "initiate_return") return null;
  const params = action.parameters as Record<string, unknown>;
  if (typeof params.amount !== "string" || typeof params.currency !== "string") return null;
  return { amount: params.amount, currency: params.currency, lineItems: params.lineItems as any };
}

/**
 * Validates a SuggestionPacket before it may be accepted as the advisor's
 * terminal output (Pass 5). Never runs during Pass 7 execution — that's
 * src/approvals/revalidate.ts's job, against fresh tool data.
 */
export function validateSuggestionPacket(packet: SuggestionPacket, ctx: CaseContext): SemanticValidationResult {
  const errors: FieldError[] = [];

  errors.push(...citationsAreTraceable(packet.policyCitations, ctx, "policyCitations"));

  // Precision-review invariant (spec Example B): an issue may never claim
  // definite (or partial) eligibility without at least one policy citation
  // backing it — "unsupported certainty" is a blocking finding, not a style note.
  packet.issues.forEach((issue, i) => {
    if ((issue.decision === "eligible" || issue.decision === "partially_eligible") && issue.policyCitationReferences.length === 0) {
      errors.push({
        path: `issues[${i}].decision`,
        message: `Issue "${issue.issueId}" claims decision "${issue.decision}" with zero policyCitationReferences — eligibility must be evidence-backed, not asserted.`,
      });
    }
  });

  if (packet.policyCitations.length > 0 && packet.dataProvenance.length === 0) {
    errors.push({ path: "dataProvenance", message: "Policy citations are present but dataProvenance is empty." });
  }

  const seenOrderTargets = new Map<string, string[]>(); // orderId -> actionIds proposing a refund against it
  for (const [i, action] of packet.proposedActions.entries()) {
    if (!action.requiresHumanApproval) {
      errors.push({ path: `proposedActions[${i}].requiresHumanApproval`, message: "Every proposed action must require human approval in Track 2." });
    }

    const moneyLike = moneyLikeAction(action);
    if (!moneyLike) continue;

    const parsedAmount = parseMoney(moneyLike.amount, moneyLike.currency);
    if (!parsedAmount.ok) {
      errors.push({ path: `proposedActions[${i}].parameters.amount`, message: parsedAmount.error.message });
      continue;
    }
    if (parsedAmount.value.minorUnits < 0) {
      errors.push({ path: `proposedActions[${i}].parameters.amount`, message: "Proposed amount must be non-negative." });
    }
    if (ctx.currency && parsedAmount.value.currency !== ctx.currency) {
      errors.push({
        path: `proposedActions[${i}].parameters.currency`,
        message: `Proposed currency "${parsedAmount.value.currency}" does not match the case's currency "${ctx.currency}".`,
      });
    }
    if (ctx.knownRemainingRefundableAmount) {
      const known = parseMoney(ctx.knownRemainingRefundableAmount.amount, ctx.knownRemainingRefundableAmount.currency);
      if (known.ok && known.value.currency === parsedAmount.value.currency && compareMoney(parsedAmount.value, known.value) > 0) {
        errors.push({
          path: `proposedActions[${i}].parameters.amount`,
          message: `Proposed amount ${moneyLike.amount} ${moneyLike.currency} exceeds the known remaining refundable balance of ${ctx.knownRemainingRefundableAmount.amount} ${ctx.knownRemainingRefundableAmount.currency}.`,
        });
      }
    }
    if (Array.isArray(moneyLike.lineItems) && moneyLike.lineItems.length > 0) {
      const total = moneyLike.lineItems.reduce((sum, li) => {
        const lineTotal = typeof li.lineTotal === "string" ? li.lineTotal : li.lineTotal.amount;
        const parsed = parseMoney(lineTotal, moneyLike.currency);
        return sum + (parsed.ok ? parsed.value.minorUnits : 0);
      }, 0);
      if (total !== parsedAmount.value.minorUnits) {
        errors.push({
          path: `proposedActions[${i}].parameters.lineItems`,
          message: `Line item totals (${formatMoney({ currency: moneyLike.currency, minorUnits: total })}) do not sum to the proposed amount (${moneyLike.amount}).`,
        });
      }
    }

    const params = action.parameters as Record<string, unknown>;
    if (typeof params.orderId === "string") {
      const list = seenOrderTargets.get(params.orderId) ?? [];
      list.push(action.actionId);
      seenOrderTargets.set(params.orderId, list);
    }
  }

  for (const [orderId, actionIds] of seenOrderTargets) {
    if (actionIds.length > 1) {
      errors.push({
        path: "proposedActions",
        message: `Multiple proposed money-moving actions (${actionIds.join(", ")}) target the same order "${orderId}" — this looks like duplicate compensation for the same loss; the cross-issue integration pass must resolve this before the packet may be submitted.`,
      });
    }
  }

  if (packet.review.status === "blocked") {
    errors.push({ path: "review.status", message: "A packet with review.status \"blocked\" may not be submitted — resolve the blocking findings first." });
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

/** Validates AdvisorCaseFacts submitted via record_case_facts (Pass 1 output). */
export function validateAdvisorCaseFacts(facts: AdvisorCaseFacts): SemanticValidationResult {
  const errors: FieldError[] = [];

  if (facts.requestedAmount && facts.eligibleAmount) {
    const requested = parseMoney(facts.requestedAmount.amount, facts.requestedAmount.currency);
    const eligible = parseMoney(facts.eligibleAmount.amount, facts.eligibleAmount.currency);
    if (requested.ok && eligible.ok && requested.value.currency !== eligible.value.currency) {
      errors.push({ path: "eligibleAmount", message: "eligibleAmount currency must match requestedAmount currency." });
    }
  }

  const statementIds = new Set(facts.statements.map((s) => s.statementId));
  facts.unresolvedContradictions.forEach((c, i) => {
    c.conflictingStatementIds.forEach((id) => {
      if (!statementIds.has(id)) {
        errors.push({ path: `unresolvedContradictions[${i}]`, message: `References unknown statementId "${id}".` });
      }
    });
  });

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/** Formats field errors into a message the model can act on directly, per-field. */
export function formatValidationErrorsForClaude(toolName: string, errors: FieldError[]): string {
  const lines = errors.map((e) => `- ${e.path}: ${e.message}`).join("\n");
  return (
    `Validation failed for ${toolName}. Fix exactly these fields and call ${toolName} again with the ` +
    `same caseId — do not repeat any side-effecting tool calls (verify_customer_identity, escalate_to_human) ` +
    `while correcting this output:\n${lines}`
  );
}

export { sumMoney };
