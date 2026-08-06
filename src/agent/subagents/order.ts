import type { ClaudeClient } from "../claudeClient.js";
import type { MercuryMcpConnection } from "../mcpClient.js";
import type { CaseContext } from "../context.js";
import { runSubagentLoop } from "../subagentLoop.js";
import { ORDER_SUBAGENT_PROMPT } from "../prompts/order.js";
import type { OrderFinding } from "../../domain/schemas.js";

export interface OrderTask {
  orderId: string;
  customerId: string;
}

export async function runOrderSubagent(
  claude: ClaudeClient,
  mcp: MercuryMcpConnection,
  context: CaseContext,
  task: OrderTask
): Promise<OrderFinding | null> {
  const initialUserMessage =
    `caseId: ${context.caseId}\norderId: ${task.orderId}\nrequestingCustomerId: ${task.customerId}\n` +
    "Look up the order and its payment/refund history.";

  const result = await runSubagentLoop<OrderFinding>({
    claude,
    mcp,
    context,
    systemPrompt: ORDER_SUBAGENT_PROMPT,
    allowedMcpTools: ["lookup_order", "get_payment_history"],
    findingToolName: "submit_order_finding",
    initialUserMessage,
  });

  return result.finding;
}
