import type { ClaudeClient } from "../claudeClient.js";
import type { MercuryMcpConnection } from "../mcpClient.js";
import type { CaseContext } from "../context.js";
import { runSubagentLoop } from "../subagentLoop.js";
import { RESOLUTION_SUBAGENT_PROMPT } from "../prompts/resolution.js";
import type { ProposalFinding } from "../../domain/schemas/proposalFinding.js";
import type { ConfidenceLevel } from "../../domain/schemas.js";

export interface ResolutionTask {
  issueId: string;
  orderId: string;
  customerId: string;
  requestedAmount: string;
  currency: string;
  policyDecision: "eligible" | "ineligible" | "partially_eligible" | "undetermined";
  policyConfidence: ConfidenceLevel;
  reason: string;
}

/**
 * Runs the Resolution-proposal specialist for a single issue. Unlike Track
 * 1's Refund subagent, this specialist has NO access to
 * create_return/process_refund (see allowedMcpTools below) — it is
 * structurally incapable of executing anything, independent of any prompt
 * instruction. Its only output is a ProposalFinding for the advisor to fold
 * into the SuggestionPacket's proposedActions.
 */
export async function runResolutionSubagent(
  claude: ClaudeClient,
  mcp: MercuryMcpConnection,
  context: CaseContext,
  task: ResolutionTask
): Promise<ProposalFinding | null> {
  const initialUserMessage =
    `caseId: ${context.caseId}\nissueId: ${task.issueId}\norderId: ${task.orderId}\ncustomerId: ${task.customerId}\n` +
    `requestedAmount: ${task.requestedAmount} ${task.currency}\n` +
    `policyDecision (already determined by the Policy specialist): ${task.policyDecision}\n` +
    `policyConfidence (already determined by the Policy specialist): ${task.policyConfidence}\n` +
    `reason: ${task.reason}\n` +
    "Draft a proposed remedy for this issue only. You cannot execute anything — propose only.";

  const result = await runSubagentLoop<ProposalFinding>({
    claude,
    mcp,
    context,
    systemPrompt: RESOLUTION_SUBAGENT_PROMPT,
    allowedMcpTools: ["get_payment_history"],
    findingToolName: "submit_resolution_finding",
    initialUserMessage,
  });

  return result.finding;
}
