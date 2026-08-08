/**
 * Auditor-readable timeline (spec section 25): aggregates the append-only
 * case-event log, the escalation queue, the suggestion-packet history, and
 * the approval store into one chronological view that distinguishes
 * customer statements from retrieved facts, advisor analysis, validation,
 * policy review, human decisions, and execution results. Never surfaces
 * chain-of-thought, secrets, or full payment-card data — every source it
 * reads from already excludes those (see src/mock-backends/caseManagement.ts,
 * src/mock-backends/approvalQueue.ts, src/approvals/store.ts).
 */

import { getCaseHistory } from "../mock-backends/caseManagement.js";
import { listEscalations } from "../mock-backends/approvalQueue.js";
import { getSuggestionHistory, getCurrentSuggestionForCase } from "../advisor/packetStore.js";
import { listApprovals } from "../approvals/store.js";

export type AuditEventKind =
  | "customer_statement"
  | "retrieved_fact"
  | "advisor_analysis"
  | "validation"
  | "policy_review"
  | "human_decision"
  | "tool_execution"
  | "execution_result";

export interface AuditTimelineEntry {
  at: string;
  kind: AuditEventKind;
  actor: string;
  summary: string;
  reference: string | null;
}

const EVENT_TYPE_KIND: Array<[RegExp, AuditEventKind]> = [
  [/verified|lookup|evaluate|customer|order|payment/i, "retrieved_fact"],
  [/suggestion|packet|proposal|analysis/i, "advisor_analysis"],
  [/valid/i, "validation"],
  [/policy/i, "policy_review"],
  [/escalat|approv|reject|revision/i, "human_decision"],
  [/execut|refund|return/i, "execution_result"],
];

function classify(eventType: string): AuditEventKind {
  for (const [pattern, kind] of EVENT_TYPE_KIND) {
    if (pattern.test(eventType)) return kind;
  }
  return "tool_execution";
}

export async function buildAuditTimeline(caseId: string): Promise<AuditTimelineEntry[]> {
  const entries: AuditTimelineEntry[] = [];

  const history = await getCaseHistory(caseId);
  if (history.success) {
    for (const event of history.events) {
      entries.push({ at: event.createdAt, kind: classify(event.eventType), actor: event.actor, summary: event.summary, reference: event.eventType });
    }
  }

  for (const escalation of listEscalations().filter((e) => e.caseId === caseId)) {
    for (const h of escalation.history) {
      entries.push({ at: h.at, kind: "human_decision", actor: h.actor, summary: h.note, reference: escalation.escalationId });
    }
  }

  const suggestionIds = new Set<string>();
  // The packet-store's version history has one entry per *save* (every
  // approve/edit/execute re-saves the current packet), not one per
  // meaningfully-new state — dedupe by (suggestionVersion) for the
  // "submitted" entry and by (status, decidedAt) for the decision entry so
  // an approve-then-execute sequence doesn't produce two identical
  // "submitted" lines or two identical decision lines.
  const seenSubmitted = new Set<string>();
  const seenDecision = new Set<string>();
  for (const packet of getAllCasePacketVersions(caseId)) {
    suggestionIds.add(packet.suggestionId);
    const submittedKey = `${packet.suggestionId}:v${packet.suggestionVersion}`;
    if (!seenSubmitted.has(submittedKey)) {
      seenSubmitted.add(submittedKey);
      entries.push({
        at: packet.createdAt,
        kind: "advisor_analysis",
        actor: "advisor_agent",
        summary: `Suggestion packet v${packet.suggestionVersion} submitted: ${packet.caseSummary}`,
        reference: packet.suggestionId,
      });
    }
    if (packet.humanDecision.decidedAt) {
      const decisionKey = `${packet.suggestionId}:${packet.humanDecision.status}:${packet.humanDecision.decidedAt}`;
      if (!seenDecision.has(decisionKey)) {
        seenDecision.add(decisionKey);
        entries.push({
          at: packet.humanDecision.decidedAt,
          kind: "human_decision",
          actor: packet.humanDecision.reviewerReference ?? "unknown_reviewer",
          summary: `Human decision: ${packet.humanDecision.status}${packet.humanDecision.comment ? ` — ${packet.humanDecision.comment}` : ""}`,
          reference: packet.suggestionId,
        });
      }
    }
  }

  for (const approval of listApprovals().filter((a) => suggestionIds.has(a.suggestionId))) {
    if (approval.executedAt) {
      entries.push({
        at: approval.executedAt,
        kind: "execution_result",
        actor: approval.reviewerReference ?? "unknown_actor",
        summary: `Action "${approval.actionId}" executed (ref: ${approval.executedTransactionRef ?? "unknown"}).`,
        reference: approval.actionId,
      });
    }
  }

  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function getAllCasePacketVersions(caseId: string) {
  // packetStore is keyed by suggestionId, not caseId directly; we don't have a
  // reverse index, so this walks every suggestionId ever seen for this case via
  // the "current" pointer plus its full version history.
  const current = getCurrentSuggestionForCase(caseId);
  if (!current) return [];
  return getSuggestionHistory(current.suggestionId);
}
