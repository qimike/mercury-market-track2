/**
 * Mock case-management system. Backs `get_case_history`, `record_case_event`,
 * and the storage side of `escalate_to_human`. In-memory only; a real
 * deployment would swap this for the actual case-management datastore.
 */

import { caseEvents, type CaseEventRecord } from "./data.js";
import { ok, fail, type ToolResult } from "../domain/errors.js";
import type { EscalationPacket, Resolution, CaseFacts } from "../domain/schemas.js";

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

interface StoredEscalation {
  escalationId: string;
  packet: EscalationPacket;
  createdAt: string;
}

const escalations = new Map<string, StoredEscalation>();
let escalationSeq = 0;

export async function escalateToHuman(
  packet: EscalationPacket
): Promise<ToolResult<{ escalationId: string }>> {
  escalationSeq += 1;
  const escalationId = `esc_${String(escalationSeq).padStart(4, "0")}`;
  const createdAt = new Date().toISOString();
  escalations.set(escalationId, { escalationId, packet, createdAt });
  caseEvents.push({
    caseId: packet.caseId,
    eventType: "escalated_to_human",
    summary: packet.escalationReason,
    actor: "coordinator",
    createdAt,
  });
  return ok({ escalationId });
}

export function getEscalation(escalationId: string): StoredEscalation | undefined {
  return escalations.get(escalationId);
}

export function listEscalations(): StoredEscalation[] {
  return [...escalations.values()];
}

const resolutions = new Map<string, Resolution>();
const caseFactsStore = new Map<string, CaseFacts>();

/** Stores the structured, schema-validated resolution for a case resolved autonomously. */
export async function recordResolution(resolution: Resolution): Promise<ToolResult<{ acknowledged: true }>> {
  resolutions.set(resolution.caseId, resolution);
  caseEvents.push({
    caseId: resolution.caseId,
    eventType: "resolved_autonomously",
    summary: resolution.internalSummary,
    actor: "coordinator",
    createdAt: new Date().toISOString(),
  });
  return ok({ acknowledged: true });
}

export function getResolution(caseId: string): Resolution | undefined {
  return resolutions.get(caseId);
}

/** Stores the latest structured CaseFacts snapshot submitted for a case. */
export async function recordCaseFacts(facts: CaseFacts): Promise<ToolResult<{ acknowledged: true }>> {
  caseFactsStore.set(facts.caseId, facts);
  return ok({ acknowledged: true });
}

export function getStoredCaseFacts(caseId: string): CaseFacts | undefined {
  return caseFactsStore.get(caseId);
}

export function _resetCaseManagementMockState(): void {
  caseEvents.length = 0;
  escalations.clear();
  escalationSeq = 0;
  resolutions.clear();
  caseFactsStore.clear();
}
