/**
 * Read-only MCP resources exposing reference data that subagents and human
 * reviewers both need: the live policy catalog, policy version/expiry
 * history, regional refund rules, escalation criteria, supported
 * regions/currencies, the support playbook, and the tool error taxonomy.
 *
 * These are resources (not tools) because they are not parameterized actions
 * — they are documents an agent (or a human in Claude Code) can read for
 * context before deciding what tool to call.
 */

import { policyCatalog } from "../mock-backends/data.js";
import { ERROR_CATEGORIES } from "../domain/errors.js";
import { SUPPORTED_REGIONS, SUPPORTED_CURRENCIES, config } from "../domain/config.js";

export interface ResourceSpec {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  read: () => string;
}

function policyStatus(doc: (typeof policyCatalog)[number], asOf: string): "active" | "expired" | "scheduled" {
  if (doc.effectiveDate > asOf) return "scheduled";
  if (doc.expirationDate && doc.expirationDate < asOf) return "expired";
  return "active";
}

export const resourceSpecs: ResourceSpec[] = [
  {
    uri: "mercury://policy/catalog",
    name: "policy-catalog",
    title: "Current Policy Catalog",
    description:
      "All policy documents currently in effect (as of the real-world present date), each with " +
      "policyId, version, region, SKU scope, effective date, expiration date, and source provenance.",
    mimeType: "application/json",
    read: () => {
      const today = new Date().toISOString().slice(0, 10);
      const active = policyCatalog.filter((d) => policyStatus(d, today) === "active");
      return JSON.stringify({ asOf: today, policies: active }, null, 2);
    },
  },
  {
    uri: "mercury://policy/history",
    name: "policy-history",
    title: "Policy Version History",
    description:
      "The full policy catalog including expired and scheduled documents, each tagged with its " +
      "status. Used to explain why a policy evaluation returned a stale/undetermined result.",
    mimeType: "application/json",
    read: () => {
      const today = new Date().toISOString().slice(0, 10);
      return JSON.stringify(
        { asOf: today, policies: policyCatalog.map((d) => ({ ...d, status: policyStatus(d, today) })) },
        null,
        2
      );
    },
  },
  {
    uri: "mercury://policy/regional-refund-rules",
    name: "regional-refund-rules",
    title: "Regional Refund Rules Summary",
    description: "Human-readable summary of return-window rules per region, derived from the policy catalog.",
    mimeType: "application/json",
    read: () => {
      const byRegion: Record<string, { returnWindowDays: number | null; policyId: string }[]> = {};
      for (const doc of policyCatalog) {
        if (doc.skuScope !== "ALL") continue;
        const key = doc.region;
        byRegion[key] ??= [];
        byRegion[key].push({ returnWindowDays: doc.returnWindowDays, policyId: doc.policyId });
      }
      return JSON.stringify(byRegion, null, 2);
    },
  },
  {
    uri: "mercury://playbook/escalation-criteria",
    name: "escalation-criteria",
    title: "Escalation Criteria",
    description:
      "The routing rules that determine autonomous resolution vs. mandatory human escalation, " +
      "including the current dollar thresholds read from configuration.",
    mimeType: "application/json",
    read: () =>
      JSON.stringify(
        {
          rules: [
            "Identity not verified -> block protected operations, do not escalate yet: ask for verification first.",
            "Identity locked (fraud review) -> block and escalate immediately.",
            "Refund amount >= mandatoryEscalationLimit -> always escalate, never autonomous.",
            "Refund amount > remaining refundable balance -> block and escalate (data integrity issue).",
            "Currency mismatch between request and order -> block and escalate.",
            "Policy confidence == low, OR any policy conflict, OR missing provenance -> escalate.",
            "Policy confidence == medium -> only safe/reversible, low-risk, low-value actions may proceed; anything else escalates.",
            "Policy confidence == high AND identity verified AND amount <= autonomousRefundLimit -> autonomous resolution allowed.",
            "Retryable tool error exhausts configured retry budget -> fail safe and escalate; never guess the result.",
          ],
          thresholds: {
            autonomousRefundLimitUSD: "150.00 (see MERCURY_AUTONOMOUS_REFUND_LIMIT)",
            mandatoryEscalationLimitUSD: "500.00 (see MERCURY_MANDATORY_ESCALATION_LIMIT)",
            maxLoopIterations: config.maxLoopIterations,
            maxToolRetries: config.maxToolRetries,
            maxOutputRetries: config.maxOutputRetries,
          },
        },
        null,
        2
      ),
  },
  {
    uri: "mercury://reference/regions-currencies",
    name: "supported-regions-currencies",
    title: "Supported Regions and Currencies",
    description: "The regions and currencies Mercury Market's mocked backends recognize.",
    mimeType: "application/json",
    read: () => JSON.stringify({ regions: SUPPORTED_REGIONS, currencies: SUPPORTED_CURRENCIES }, null, 2),
  },
  {
    uri: "mercury://playbook/support-playbook",
    name: "support-playbook",
    title: "Customer Support Playbook",
    description: "Narrative guidance for handling each issue type end-to-end via the subagent model.",
    mimeType: "text/markdown",
    read: () => SUPPORT_PLAYBOOK_MD,
  },
  {
    uri: "mercury://reference/error-taxonomy",
    name: "error-taxonomy",
    title: "Tool Error Taxonomy",
    description: "The structured error categories every tool uses, and how the agent loop should react to each.",
    mimeType: "application/json",
    read: () =>
      JSON.stringify(
        {
          categories: ERROR_CATEGORIES.map((c) => ({ category: c, guidance: ERROR_GUIDANCE[c] })),
        },
        null,
        2
      ),
  },
];

const ERROR_GUIDANCE: Record<string, string> = {
  VALIDATION: "Input was malformed or out of range. Do not retry with the same input; fix the input or escalate.",
  ACCESS: "Caller lacks permission or a precondition (e.g. verified identity) is unmet. Never bypass; resolve the precondition or escalate.",
  NOT_FOUND: "The referenced entity does not exist. Do not fabricate a substitute; report or escalate.",
  CONFLICT: "The requested operation conflicts with existing state (e.g. exceeds balance). Do not retry; escalate.",
  RATE_LIMIT: "Caller exceeded a rate limit. Retryable with backoff, bounded by maxToolRetries.",
  DEPENDENCY: "A downstream dependency (e.g. payment gateway) failed. Retryable with backoff, bounded by maxToolRetries.",
  TRANSIENT: "A transient, likely self-resolving failure. Retryable with backoff, bounded by maxToolRetries.",
  POLICY_AMBIGUITY: "Policy could not be resolved unambiguously (conflict or staleness). Never guess; escalate.",
  INTERNAL: "Unexpected internal failure. Not retryable by default; escalate with full trace.",
};

const SUPPORT_PLAYBOOK_MD = `# Mercury Market Customer Support Playbook

## General flow
1. Identity subagent establishes/confirms identity status before any customer-specific lookup.
2. Order subagent gathers order facts (read-only, parallelizable with policy retrieval).
3. Policy subagent evaluates applicable policy for the region/SKU/issue (parallelizable with order lookup).
4. Refund subagent validates eligibility, amount, currency, and remaining balance, then either
   executes an autonomous refund or produces the facts needed for escalation.
5. The coordinator assembles either a resolution summary or an Escalation Packet.

## Per issue type
- **return**: Order subagent confirms delivered status and line items -> Policy subagent evaluates
  return-window and category eligibility -> if eligible, create_return then process_refund.
- **billing_dispute**: Order + payment history first; if unexplained by known transactions, escalate
  with full transaction list rather than guessing.
- **account_issue**: Identity subagent only; never touch orders/refunds for account-only issues.
- **refund_request**: Same as return but skips create_return if no physical item is being sent back
  (e.g. duplicate charge).
- **order_issue**: Order subagent only, read-only, no refund unless the customer explicitly requests one.
- **policy_question**: Policy subagent only; answer from citations, never from memory.

## Never
- Never fabricate customer facts, order IDs, refund IDs, policy citations, or tool results.
- Never guess between two conflicting policies — preserve both and escalate.
- Never execute \`process_refund\` without a prior successful \`verify_customer_identity\`.
`;

export function getResourceSpec(uri: string): ResourceSpec | undefined {
  return resourceSpecs.find((r) => r.uri === uri);
}
