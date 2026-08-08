/**
 * In-memory store for submitted suggestion packets — the source both the
 * human-approval CLI (src/cli/) and src/approvals/decide.ts read from and
 * write back to. Keyed by suggestionId; a new suggestionVersion for the same
 * case overwrites the "current" pointer but never deletes prior versions
 * (append-only version history, spec section 25).
 */

import type { SuggestionPacket } from "../domain/schemas/suggestionPacket.js";

const versions = new Map<string, SuggestionPacket[]>();
const current = new Map<string, string>();

export function recordSuggestionPacket(packet: SuggestionPacket): void {
  const history = versions.get(packet.suggestionId) ?? [];
  history.push(packet);
  versions.set(packet.suggestionId, history);
  current.set(packet.caseId, packet.suggestionId);
}

export function getSuggestionPacket(suggestionId: string): SuggestionPacket | undefined {
  const history = versions.get(suggestionId);
  return history?.[history.length - 1];
}

export function getCurrentSuggestionForCase(caseId: string): SuggestionPacket | undefined {
  const suggestionId = current.get(caseId);
  return suggestionId ? getSuggestionPacket(suggestionId) : undefined;
}

export function getSuggestionHistory(suggestionId: string): SuggestionPacket[] {
  return versions.get(suggestionId) ?? [];
}

export function replaceSuggestionPacket(packet: SuggestionPacket): void {
  recordSuggestionPacket(packet);
}

export function listAllSuggestionPackets(): SuggestionPacket[] {
  return [...versions.values()].map((history) => history[history.length - 1]!).filter(Boolean);
}

export function _resetPacketStoreMockState(): void {
  versions.clear();
  current.clear();
}
