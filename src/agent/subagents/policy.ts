import type { ClaudeClient } from "../claudeClient.js";
import type { MercuryMcpConnection } from "../mcpClient.js";
import type { CaseContext } from "../context.js";
import { runSubagentLoop } from "../subagentLoop.js";
import { POLICY_SUBAGENT_PROMPT } from "../prompts/policy.js";
import type { PolicyFinding } from "../../domain/schemas.js";

export interface PolicyTask {
  region: string;
  sku: string;
  issueType: "return" | "refund_request";
  deliveryDate: string | null;
  asOfDate: string;
}

export async function runPolicySubagent(
  claude: ClaudeClient,
  mcp: MercuryMcpConnection,
  context: CaseContext,
  task: PolicyTask
): Promise<PolicyFinding | null> {
  const initialUserMessage =
    `caseId: ${context.caseId}\nregion: ${task.region}\nsku: ${task.sku}\nissueType: ${task.issueType}\n` +
    `deliveryDate: ${task.deliveryDate ?? "unknown"}\nasOfDate: ${task.asOfDate}\n` +
    "Evaluate policy for this region/SKU as of this date.";

  const result = await runSubagentLoop<PolicyFinding>({
    claude,
    mcp,
    context,
    systemPrompt: POLICY_SUBAGENT_PROMPT,
    allowedMcpTools: ["evaluate_policy"],
    findingToolName: "submit_policy_finding",
    initialUserMessage,
  });

  return result.finding;
}
