import type { ClaudeClient } from "../claudeClient.js";
import type { MercuryMcpConnection } from "../mcpClient.js";
import type { CaseContext } from "../context.js";
import { runSubagentLoop } from "../subagentLoop.js";
import { REFUND_SUBAGENT_PROMPT } from "../prompts/refund.js";
import type { RefundFinding, ConfidenceLevel } from "../../domain/schemas.js";

export interface RefundTask {
  orderId: string;
  customerId: string;
  requestedAmount: string;
  currency: string;
  policyDecision: "eligible" | "ineligible" | "partially_eligible" | "undetermined";
  policyConfidence: ConfidenceLevel;
  reason: string;
}

export async function runRefundSubagent(
  claude: ClaudeClient,
  mcp: MercuryMcpConnection,
  context: CaseContext,
  task: RefundTask
): Promise<RefundFinding | null> {
  const initialUserMessage =
    `caseId: ${context.caseId}\norderId: ${task.orderId}\ncustomerId: ${task.customerId}\n` +
    `requestedAmount: ${task.requestedAmount} ${task.currency}\n` +
    `policyDecision (already determined by the Policy subagent): ${task.policyDecision}\n` +
    `policyConfidence (already determined by the Policy subagent): ${task.policyConfidence}\n` +
    `reason: ${task.reason}\n` +
    "Validate the amount against the remaining refundable balance and, only if appropriate per your " +
    "rules, execute the refund.";

  const result = await runSubagentLoop<RefundFinding>({
    claude,
    mcp,
    context,
    systemPrompt: REFUND_SUBAGENT_PROMPT,
    allowedMcpTools: ["get_payment_history", "create_return", "process_refund"],
    findingToolName: "submit_refund_finding",
    initialUserMessage,
  });

  return result.finding;
}
