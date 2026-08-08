/**
 * Persistent typed investigation scratchpad (spec section 24). Distinct from
 * CaseContext's provenance/audit trail: a scratchpad entry is an explicit,
 * human- or advisor-authored note with a status the investigation can later
 * resolve or contradict — never raw model chain-of-thought, secrets, or
 * unnecessary personal data.
 */

import { randomUUID } from "node:crypto";

export const SCRATCHPAD_CATEGORIES = [
  "verified_insight",
  "open_question",
  "contradiction",
  "hypothesis",
  "policy_note",
  "failed_lookup",
  "next_investigation_step",
] as const;
export type ScratchpadCategory = (typeof SCRATCHPAD_CATEGORIES)[number];

export const SCRATCHPAD_STATUSES = ["verified", "unverified", "contradicted", "resolved"] as const;
export type ScratchpadStatus = (typeof SCRATCHPAD_STATUSES)[number];

export interface ScratchpadEntry {
  entryId: string;
  caseId: string;
  sessionId: string;
  category: ScratchpadCategory;
  statement: string;
  status: ScratchpadStatus;
  sourceReferences: string[];
  creatorType: "advisor_agent" | "human_support_agent";
  creatorReference: string;
  createdAt: string;
  updatedAt: string;
}

const DISALLOWED_PATTERNS = [/\bpassword\b/i, /\bssn\b/i, /\bsocial security\b/i, /\b\d{13,19}\b/ /* card-number-shaped */];

export function assertSafeStatement(statement: string): void {
  for (const pattern of DISALLOWED_PATTERNS) {
    if (pattern.test(statement)) {
      throw new Error("Scratchpad entries may not contain secrets, passwords, or full payment-card-shaped numbers.");
    }
  }
}

const entries = new Map<string, ScratchpadEntry[]>(); // keyed by caseId

export function recordScratchpadEntry(input: {
  caseId: string;
  sessionId: string;
  category: ScratchpadCategory;
  statement: string;
  status: ScratchpadStatus;
  sourceReferences: string[];
  creatorType: ScratchpadEntry["creatorType"];
  creatorReference: string;
}): ScratchpadEntry {
  assertSafeStatement(input.statement);
  const now = new Date().toISOString();
  const entry: ScratchpadEntry = {
    entryId: `scratch_${randomUUID()}`,
    caseId: input.caseId,
    sessionId: input.sessionId,
    category: input.category,
    statement: input.statement,
    status: input.status,
    sourceReferences: input.sourceReferences,
    creatorType: input.creatorType,
    creatorReference: input.creatorReference,
    createdAt: now,
    updatedAt: now,
  };
  const list = entries.get(input.caseId) ?? [];
  list.push(entry);
  entries.set(input.caseId, list);
  return entry;
}

export function updateScratchpadStatus(caseId: string, entryId: string, status: ScratchpadStatus): ScratchpadEntry | null {
  const list = entries.get(caseId) ?? [];
  const entry = list.find((e) => e.entryId === entryId);
  if (!entry) return null;
  entry.status = status;
  entry.updatedAt = new Date().toISOString();
  return entry;
}

export function getScratchpad(caseId: string): ScratchpadEntry[] {
  return entries.get(caseId) ?? [];
}

/**
 * Fork copy: only entries tagged `verified` or already `resolved` carry over
 * to a forked investigation — open questions/contradictions/hypotheses stay
 * with the parent so the fork starts from settled facts, not live disputes.
 */
export function copyScratchpadForFork(parentCaseId: string, forkSessionId: string): ScratchpadEntry[] {
  const carryOver = getScratchpad(parentCaseId).filter((e) => e.status === "verified" || e.status === "resolved");
  return carryOver.map((e) => recordScratchpadEntry({
    caseId: parentCaseId,
    sessionId: forkSessionId,
    category: e.category,
    statement: e.statement,
    status: e.status,
    sourceReferences: e.sourceReferences,
    creatorType: e.creatorType,
    creatorReference: e.creatorReference,
  }));
}

export function _resetScratchpadMockState(): void {
  entries.clear();
}
