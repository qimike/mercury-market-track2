/**
 * Mock policy repository. Backs `evaluate_policy` and the read-only MCP
 * resources (policy catalog / version history / regional refund rules).
 *
 * This module answers "what does policy say" for a given region + SKU as of a
 * given date, including precedence and conflict detection between a
 * region-wide rule and a SKU/category-specific rule. It does NOT compute a
 * dollar eligible amount — that requires order line items, which is the
 * Policy/Refund subagents' job once they combine this result with OMS facts.
 */

import { policyCatalog, type PolicyDocument } from "./data.js";
import { fail, ok, type ToolResult } from "../domain/errors.js";
import { PolicyCitationSchema, type PolicyCitation, type ConfidenceLevel } from "../domain/schemas.js";

export interface PolicyConflict {
  policyA: string;
  policyB: string;
  description: string;
}

export interface PolicyEvaluationOutput {
  decision: "eligible" | "ineligible" | "partially_eligible" | "undetermined";
  confidence: ConfidenceLevel;
  withinReturnWindow: boolean | null;
  citations: PolicyCitation[];
  conflicts: PolicyConflict[];
  ambiguities: string[];
}

export interface EvaluatePolicyInput {
  region: string;
  sku: string;
  issueType: string;
  deliveryDate: string | null;
  asOfDate: string;
  traceId: string;
}

function toCitation(doc: PolicyDocument, traceId: string, retrievedAt: string): PolicyCitation {
  const citation = {
    policyId: doc.policyId,
    version: doc.version,
    title: doc.title,
    region: doc.region,
    skuScope: doc.skuScope,
    effectiveDate: doc.effectiveDate,
    expirationDate: doc.expirationDate,
    excerpt: doc.excerpt,
    provenance: {
      sourceType: "policy_document" as const,
      sourceId: doc.sourceFile,
      policyId: doc.policyId,
      policyVersion: doc.version,
      effectiveDate: doc.effectiveDate,
      retrievedAt,
      traceId,
    },
  };
  return PolicyCitationSchema.parse(citation);
}

function isEffective(doc: PolicyDocument, asOfDate: string): boolean {
  if (doc.effectiveDate > asOfDate) return false;
  if (doc.expirationDate && doc.expirationDate < asOfDate) return false;
  return true;
}

function matchesScope(doc: PolicyDocument, region: string, sku: string): boolean {
  const regionMatch = doc.region === "ALL" || doc.region === region;
  const skuMatch = doc.skuScope === "ALL" || doc.skuScope === sku;
  return regionMatch && skuMatch;
}

function withinWindow(doc: PolicyDocument, deliveryDate: string | null, asOfDate: string): boolean | null {
  if (doc.returnWindowDays === null || !deliveryDate) return null;
  const delivered = new Date(deliveryDate + "T00:00:00Z").getTime();
  const asOf = new Date(asOfDate + "T00:00:00Z").getTime();
  const elapsedDays = Math.floor((asOf - delivered) / (1000 * 60 * 60 * 24));
  return elapsedDays <= doc.returnWindowDays;
}

export async function evaluatePolicy(
  input: EvaluatePolicyInput
): Promise<ToolResult<PolicyEvaluationOutput>> {
  if (input.issueType !== "return" && input.issueType !== "refund_request") {
    return fail(
      "VALIDATION",
      "UNSUPPORTED_ISSUE_TYPE",
      `evaluate_policy does not support issueType "${input.issueType}".`,
      false
    );
  }

  const retrievedAt = new Date().toISOString();
  const allScoped = policyCatalog.filter((d) => matchesScope(d, input.region, input.sku));
  // A fully-global (region "ALL" + skuScope "ALL") document is only a fallback of
  // last resort: if any more-specific document exists in scope — a region-specific
  // general rule, a SKU-specific rule, or both — it takes precedence in
  // consideration, even if that more-specific rule has since expired. This is what
  // makes a lapsed category-specific policy a genuine "stale policy" gap rather
  // than silently falling back to the generic default.
  const hasMoreSpecificDoc = allScoped.some((d) => !(d.region === "ALL" && d.skuScope === "ALL"));
  const scoped = hasMoreSpecificDoc ? allScoped.filter((d) => !(d.region === "ALL" && d.skuScope === "ALL")) : allScoped;
  const effective = scoped.filter((d) => isEffective(d, input.asOfDate));

  if (effective.length === 0) {
    const mostRecentExpired = [...scoped].sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1))[0];
    const ambiguity = mostRecentExpired
      ? `No currently-effective policy for SKU "${input.sku}" in region "${input.region}" as of ${input.asOfDate}; ` +
        `the most recent applicable policy (${mostRecentExpired.policyId} v${mostRecentExpired.version}) ` +
        `expired ${mostRecentExpired.expirationDate ?? "unknown"}.`
      : `No policy document found for SKU "${input.sku}" in region "${input.region}".`;
    return ok({
      decision: "undetermined",
      confidence: "low",
      withinReturnWindow: null,
      citations: mostRecentExpired ? [toCitation(mostRecentExpired, input.traceId, retrievedAt)] : [],
      conflicts: [],
      ambiguities: [ambiguity],
    });
  }

  const returnableValues = new Set(effective.map((d) => d.returnable));
  const citations = effective
    .sort((a, b) => b.precedence - a.precedence)
    .map((d) => toCitation(d, input.traceId, retrievedAt));

  if (returnableValues.size === 1) {
    const returnable = effective[0]!.returnable;
    const highestPrecedence = [...effective].sort((a, b) => b.precedence - a.precedence)[0]!;
    const confidence: ConfidenceLevel = effective.length === 1 ? "high" : "medium";
    const window = withinWindow(highestPrecedence, input.deliveryDate, input.asOfDate);
    return ok({
      decision: returnable ? (window === false ? "ineligible" : "eligible") : "ineligible",
      confidence: window === false ? "medium" : confidence,
      withinReturnWindow: window,
      citations,
      conflicts: [],
      ambiguities: window === false ? [`Return requested outside the ${highestPrecedence.returnWindowDays}-day window.`] : [],
    });
  }

  // Disagreement across effective policies. Only resolved (non-conflict) if the
  // highest-precedence policy explicitly supersedes every other effective policy.
  const sortedByPrecedence = [...effective].sort((a, b) => b.precedence - a.precedence);
  const top = sortedByPrecedence[0]!;
  const others = sortedByPrecedence.slice(1);
  const explicitlyResolved = others.every((o) => top.supersedes.includes(o.policyId));

  if (explicitlyResolved) {
    const window = withinWindow(top, input.deliveryDate, input.asOfDate);
    return ok({
      decision: top.returnable ? (window === false ? "ineligible" : "eligible") : "ineligible",
      confidence: "medium",
      withinReturnWindow: window,
      citations,
      conflicts: [],
      ambiguities: [
        `${top.policyId} v${top.version} explicitly supersedes ${others.map((o) => o.policyId).join(", ")} for this scope.`,
      ],
    });
  }

  const conflicts: PolicyConflict[] = others.map((o) => ({
    policyA: top.policyId,
    policyB: o.policyId,
    description:
      `${top.policyId} v${top.version} (${top.returnable ? "returnable" : "non-returnable"}) conflicts with ` +
      `${o.policyId} v${o.version} (${o.returnable ? "returnable" : "non-returnable"}) for SKU "${input.sku}" ` +
      `in region "${input.region}"; neither document declares precedence over the other.`,
  }));

  return ok({
    decision: "undetermined",
    confidence: "low",
    withinReturnWindow: null,
    citations,
    conflicts,
    ambiguities: conflicts.map((c) => c.description),
  });
}

export function getPolicyCatalog(): PolicyDocument[] {
  return policyCatalog;
}
