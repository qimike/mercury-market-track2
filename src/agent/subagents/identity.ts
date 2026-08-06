import type { ClaudeClient } from "../claudeClient.js";
import type { MercuryMcpConnection } from "../mcpClient.js";
import type { CaseContext } from "../context.js";
import { runSubagentLoop } from "../subagentLoop.js";
import { IDENTITY_SUBAGENT_PROMPT } from "../prompts/identity.js";
import type { IdentityFinding } from "../../domain/schemas.js";

export interface IdentityTask {
  customerId: string;
  verificationValue?: string;
}

export async function runIdentitySubagent(
  claude: ClaudeClient,
  mcp: MercuryMcpConnection,
  context: CaseContext,
  task: IdentityTask
): Promise<IdentityFinding | null> {
  const initialUserMessage =
    `caseId: ${context.caseId}\ncustomerId: ${task.customerId}\n` +
    (task.verificationValue
      ? `The customer supplied this verification value: "${task.verificationValue}". Attempt verification.`
      : "No verification value supplied yet. Look up current identity status only; do not attempt verification.");

  const result = await runSubagentLoop<IdentityFinding>({
    claude,
    mcp,
    context,
    systemPrompt: IDENTITY_SUBAGENT_PROMPT,
    allowedMcpTools: ["get_customer", "verify_customer_identity"],
    findingToolName: "submit_identity_finding",
    initialUserMessage,
  });

  return result.finding;
}
