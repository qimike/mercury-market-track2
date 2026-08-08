/**
 * Bridges the agent loop to MCP tool calls: runs programmatic hooks first
 * (src/agent/hooks.ts), then calls the tool through the real MCP protocol
 * (src/agent/mcpClient.ts), then applies bounded retry-with-backoff — but
 * ONLY for errors the tool explicitly marked `isRetryable`. A NOT_FOUND or
 * VALIDATION error is never retried; a DEPENDENCY/TRANSIENT/RATE_LIMIT error
 * is retried up to `config.maxToolRetries` times before being returned as-is
 * for the coordinator to escalate.
 */

import type { MercuryMcpConnection } from "./mcpClient.js";
import { runPreToolHooks, type HookContext } from "./hooks.js";
import { config } from "../domain/config.js";
import type { ToolResult } from "../domain/errors.js";

export interface ToolCallOutcome {
  toolName: string;
  input: Record<string, unknown>;
  result: ToolResult<Record<string, unknown>>;
  attempts: number;
  blockedByHook: boolean;
  forceEscalation: boolean;
}

function backoffMs(attempt: number): number {
  return Math.min(50 * 2 ** attempt, 400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeTool(
  connection: MercuryMcpConnection,
  toolName: string,
  input: Record<string, unknown>,
  hookCtx: HookContext
): Promise<ToolCallOutcome> {
  const decision = runPreToolHooks(toolName, input, hookCtx);

  if (!decision.allow) {
    return {
      toolName,
      input,
      result: { success: false, error: decision.blockedError! },
      attempts: 0,
      blockedByHook: true,
      forceEscalation: decision.forceEscalation,
    };
  }

  const finalInput = { ...input, ...(decision.overrideInput ?? {}) };

  let attempts = 0;
  let result: ToolResult<Record<string, unknown>>;
  while (true) {
    attempts += 1;
    result = await connection.callTool(toolName, finalInput);
    if (result.success) break;
    const retryable = result.error.isRetryable && attempts <= config.maxRetries;
    if (!retryable) break;
    await sleep(backoffMs(attempts));
  }

  return {
    toolName,
    input: finalInput,
    result,
    attempts,
    blockedByHook: false,
    forceEscalation: decision.forceEscalation,
  };
}
