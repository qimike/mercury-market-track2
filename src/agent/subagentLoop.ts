/**
 * A bounded, single-purpose deterministic loop for one of the four
 * specialized subagents (Identity/Order/Policy/Refund). Mirrors the same
 * loop mechanics as the coordinator's AgentLoop (src/agent/loop.ts) — send
 * conversation+tools, inspect the response, execute+validate tool calls,
 * append results, enforce max iterations, detect duplicate calls, preserve
 * trace — but terminates on a single subagent-specific `submit_*_finding`
 * tool instead of the coordinator's resolve_case/escalate_to_human pair, and
 * only offers a restricted subset of MCP tools (its "boundary" per the spec).
 *
 * Kept as a separate, smaller engine rather than folding into AgentLoop
 * because subagent termination semantics are genuinely simpler (one finding
 * tool, no fail-safe EscalationPacket authoring) — reusing hooks.ts,
 * toolExecutor.ts, and context.ts keeps the actual enforcement logic shared.
 */

import type { ClaudeClient, ClaudeMessageParam, ClaudeToolResultBlock, ClaudeToolUseBlock } from "./claudeClient.js";
import type { MercuryMcpConnection } from "./mcpClient.js";
import { executeTool } from "./toolExecutor.js";
import type { CaseContext } from "./context.js";
import { toolSpecs } from "../mcp/toolDefinitions.js";
import { config } from "../domain/config.js";
import type { TraceEntry } from "./loop.js";

const MAX_IDENTICAL_TOOL_CALLS = 3;

export interface SubagentLoopResult<T> {
  finding: T | null;
  outcome: "submitted" | "max_iterations_exceeded" | "duplicate_tool_call_loop";
  iterations: number;
  trace: TraceEntry[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export async function runSubagentLoop<T>(options: {
  claude: ClaudeClient;
  mcp: MercuryMcpConnection;
  systemPrompt: string;
  context: CaseContext;
  allowedMcpTools: string[];
  findingToolName: string;
  initialUserMessage: string;
}): Promise<SubagentLoopResult<T>> {
  const { claude, mcp, systemPrompt, context, allowedMcpTools, findingToolName, initialUserMessage } = options;
  const sideEffectingTools = new Set(toolSpecs.filter((t) => t.sideEffecting).map((t) => t.name));
  const allowedSet = new Set([...allowedMcpTools, findingToolName]);
  const signatureCounts = new Map<string, number>();

  const messages: ClaudeMessageParam[] = [{ role: "user", content: initialUserMessage }];
  const trace: TraceEntry[] = [];
  const allDefs = await mcp.listToolDefinitions();
  const toolDefs = allDefs.filter((t) => allowedSet.has(t.name));

  let iteration = 0;
  while (true) {
    iteration += 1;
    if (iteration > config.maxAgentSteps) {
      return { finding: null, outcome: "max_iterations_exceeded", iterations: iteration, trace };
    }

    const response = await claude.createMessage({ model: config.model, system: systemPrompt, messages, tools: toolDefs });
    const toolUseBlocks = response.content.filter((b): b is ClaudeToolUseBlock => b.type === "tool_use");
    const traceEntry: TraceEntry = { iteration, stopReason: response.stopReason, assistantContent: response.content, toolCalls: [] };
    trace.push(traceEntry);
    messages.push({ role: "assistant", content: response.content });

    if (toolUseBlocks.length === 0) {
      messages.push({
        role: "user",
        content: `You must call ${findingToolName} to report your finding before ending — you have not done so yet.`,
      });
      continue;
    }

    const anySideEffecting = toolUseBlocks.some((b) => sideEffectingTools.has(b.name));
    const resultBlocks: ClaudeToolResultBlock[] = [];
    let finding: T | null = null;
    let stuck = false;

    const runOne = async (toolUse: ClaudeToolUseBlock): Promise<ClaudeToolResultBlock> => {
      if (!allowedSet.has(toolUse.name)) {
        traceEntry.toolCalls.push({ name: toolUse.name, input: toolUse.input, success: false, attempts: 0, blockedByHook: true });
        return {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            success: false,
            error: {
              errorCode: "TOOL_OUT_OF_SCOPE",
              errorCategory: "ACCESS",
              message: `Tool "${toolUse.name}" is outside this subagent's boundary.`,
              isRetryable: false,
            },
          }),
          is_error: true,
        };
      }

      const signature = `${toolUse.name}:${stableStringify(toolUse.input)}`;
      const count = (signatureCounts.get(signature) ?? 0) + 1;
      signatureCounts.set(signature, count);
      if (count >= MAX_IDENTICAL_TOOL_CALLS) {
        stuck = true;
        traceEntry.toolCalls.push({ name: toolUse.name, input: toolUse.input, success: false, attempts: 0, blockedByHook: false });
        return {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            success: false,
            error: {
              errorCode: "DUPLICATE_TOOL_CALL_LOOP",
              errorCategory: "INTERNAL",
              message: `The exact call ${toolUse.name}(${JSON.stringify(toolUse.input)}) has been repeated ${count} times.`,
              isRetryable: false,
            },
          }),
          is_error: true,
        };
      }

      const outcome = await executeTool(mcp, toolUse.name, toolUse.input, context.toHookContext());
      context.ingest(outcome, toolUse.id);
      traceEntry.toolCalls.push({
        name: toolUse.name,
        input: toolUse.input,
        success: outcome.result.success,
        attempts: outcome.attempts,
        blockedByHook: outcome.blockedByHook,
      });

      if (toolUse.name === findingToolName && outcome.result.success) {
        finding = toolUse.input as T;
      }

      const projected = context.projectForClaude(toolUse.name, outcome.result as Record<string, unknown>);
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(projected),
        is_error: !outcome.result.success,
      };
    };

    if (anySideEffecting) {
      for (const toolUse of toolUseBlocks) resultBlocks.push(await runOne(toolUse));
    } else {
      resultBlocks.push(...(await Promise.all(toolUseBlocks.map(runOne))));
    }

    messages.push({ role: "user", content: resultBlocks });

    if (stuck) {
      return { finding: null, outcome: "duplicate_tool_call_loop", iterations: iteration, trace };
    }
    if (finding !== null) {
      return { finding, outcome: "submitted", iterations: iteration, trace };
    }
  }
}
