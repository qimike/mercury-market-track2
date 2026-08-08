/**
 * Mock case-management system. Backs `get_case_history` and
 * `record_case_event` (append-only audit log) plus storage of the advisor's
 * structured case-facts snapshot. Escalation queue storage lives in
 * `approvalQueue.ts` (spec section 11: escalate_to_human is now a typed
 * queue write, not a terminal "case closed" record) and suggestion-packet
 * storage lives in `src/governance/packetStore.ts`. In-memory only; a real
 * deployment would swap this for the actual case-management datastore.
 */

import { caseEvents, type CaseEventRecord } from "./data.js";
import { ok, fail, type ToolResult } from "../domain/errors.js";
import type { AdvisorCaseFacts } from "../domain/schemas/advisorCaseFacts.js";

export interface CaseHistory {
  events: CaseEventRecord[];
}

export async function getCaseHistory(caseId: string): Promise<ToolResult<CaseHistory>> {
  const events = caseEvents.filter((e) => e.caseId === caseId);
  return ok({ events });
}

export async function recordCaseEvent(
  caseId: string,
  eventType: string,
  summary: string,
  actor: string
): Promise<ToolResult<{ event: CaseEventRecord }>> {
  if (!caseId || !eventType || !summary) {
    return fail("VALIDATION", "MISSING_FIELDS", "caseId, eventType, and summary are required.", false);
  }
  const event: CaseEventRecord = { caseId, eventType, summary, actor, createdAt: new Date().toISOString() };
  caseEvents.push(event);
  return ok({ event });
}

const caseFactsStore = new Map<string, AdvisorCaseFacts>();

/** Stores the latest structured AdvisorCaseFacts snapshot submitted for a case (Pass 1 output). */
export async function recordCaseFacts(facts: AdvisorCaseFacts): Promise<ToolResult<{ acknowledged: true }>> {
  caseFactsStore.set(facts.caseId, facts);
  return ok({ acknowledged: true });
}

export function getStoredCaseFacts(caseId: string): AdvisorCaseFacts | undefined {
  return caseFactsStore.get(caseId);
}

export function _resetCaseManagementMockState(): void {
  caseEvents.length = 0;
  caseFactsStore.clear();
}
