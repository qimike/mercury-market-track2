/**
 * Advisor-facing entry point (spec section 5/9). Wraps the underlying
 * deterministic loop engine reused from Track 1 (src/agent/coordinator.ts,
 * loop.ts, subagentLoop.ts — the multi-pass mechanics described in
 * docs/track2-architecture.md: facts -> per-issue specialists -> integration
 * -> precision review, all enforced by src/agent/validation.ts before a
 * submit_suggestion_packet call is accepted) behind a single call a CLI or
 * API can use without knowing about MCP connections or CaseContext. Always
 * opens its MCP connection as `advisor_agent` — never anything else.
 */

import type { ClaudeClient, ClaudeMessageParam } from "../agent/claudeClient.js";
import { connectMercuryMcp } from "../agent/mcpClient.js";
import { runCoordinator } from "../agent/coordinator.js";
import type { LoopResult } from "../agent/loop.js";
import { getCurrentSuggestionForCase } from "./packetStore.js";
import type { SuggestionPacket } from "../domain/schemas/suggestionPacket.js";

export interface RunAdvisorOptions {
  claude: ClaudeClient;
  caseId: string;
  sessionId: string;
  initialUserMessage: string;
  /** Seeds the run from a resumed session's transcript (spec section 23). */
  resumeTranscript?: ClaudeMessageParam[];
}

export interface RunAdvisorResult {
  loopResult: LoopResult;
  suggestionPacket: SuggestionPacket | null;
}

export async function runAdvisor(options: RunAdvisorOptions): Promise<RunAdvisorResult> {
  const mcp = await connectMercuryMcp({
    traceId: options.sessionId,
    readOnlySession: false,
    callerRole: "advisor_agent",
    sessionId: options.sessionId,
  });
  try {
    const loopResult = await runCoordinator({
      claude: options.claude,
      mcp,
      caseId: options.caseId,
      traceId: options.sessionId,
      initialUserMessage: options.initialUserMessage,
      resumeTranscript: options.resumeTranscript,
    });
    const suggestionPacket = loopResult.outcome === "resolved" ? getCurrentSuggestionForCase(options.caseId) ?? null : null;
    return { loopResult, suggestionPacket };
  } finally {
    await mcp.close();
  }
}
