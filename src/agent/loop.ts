/**
 * The deterministic agentic loop (spec section 1). One instance runs one
 * subagent OR the coordinator's own top-level reasoning; the coordinator
 * (src/agent/coordinator.ts) creates and drives one AgentLoop per subagent
 * delegation plus one for its own final assembly.
 *
 * Steps, matching the spec 1:1:
 *  1. send conversation + tools to Claude               -> claude.createMessage
 *  2. inspect the response                                -> response.stopReason / content
 *  3. continue when tool_use                              -> toolUseBlocks.length > 0
 *  4. execute + validate requested tools                  -> executeTool (hooks -> MCP -> retry)
 *  5. add tool results back into the conversation          -> messages.push({role:"user", content: toolResultBlocks})
 *  6. continue reasoning                                   -> loop
 *  7. terminate on end_turn or a terminal state            -> resolve_case / escalate_to_human
 *  8. enforce max iterations                               -> config.maxLoopIterations
 *  9. detect repeated/duplicate tool-call loops            -> signatureCounts
 * 10. preserve trace information across iterations         -> trace[]
 */

import {
  type ClaudeClient,
  type ClaudeMessageParam,
  type ClaudeResponseBlock,
  type ClaudeToolResultBlock,
  type ClaudeToolUseBlock,
  type ClaudeStopReason,
} from "./claudeClient.js";
import type { MercuryMcpConnection } from "./mcpClient.js";
import { executeTool, type ToolCallOutcome } from "./toolExecutor.js";
import { CaseContext } from "./context.js";
import {
  validateResolution,
  validateEscalationPacket,
  validateCaseFacts,
  formatValidationErrorsForClaude,
} from "./validation.js";
import type { Resolution, EscalationPacket, CaseFacts } from "../domain/schemas.js";
import { toolSpecs } from "../mcp/toolDefinitions.js";
import { config } from "../domain/config.js";
import type { ToolResult } from "../domain/errors.js";

/**
 * A "local tool" is handled by the loop itself rather than routed through the
 * MCP client — used by the coordinator's delegate_to_*_subagent tools, which
 * run a nested AgentLoop rather than calling a backend directly. Local tools
 * still participate in duplicate-call detection and side-effecting batch
 * sequencing exactly like MCP tools do.
 */
export interface LocalToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  sideEffecting: boolean;
  handler: (input: Record<string, unknown>, context: CaseContext) => Promise<ToolResult<Record<string, unknown>>>;
}

const MAX_IDENTICAL_TOOL_CALLS = 3;

export interface TraceEntry {
  iteration: number;
  stopReason: ClaudeStopReason;
  assistantContent: ClaudeResponseBlock[];
  toolCalls: Array<{
    name: string;
    input: unknown;
    success: boolean;
    attempts: number;
    blockedByHook: boolean;
  }>;
}

export interface LoopResult {
  outcome: "resolved" | "escalated";
  terminationReason:
    | "resolve_case"
    | "escalate_to_human"
    | "max_iterations_exceeded"
    | "duplicate_tool_call_loop"
    | "structured_output_retry_exhausted";
  iterations: number;
  trace: TraceEntry[];
  context: CaseContext;
  transcript: ClaudeMessageParam[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function toolResultBlock(toolUseId: string, content: unknown, isError: boolean): ClaudeToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: typeof content === "string" ? content : JSON.stringify(content),
    is_error: isError,
  };
}

const TERMINAL_TOOLS = new Set(["resolve_case", "escalate_to_human"]);

export class AgentLoop {
  private readonly signatureCounts = new Map<string, number>();
  private outputRetriesUsed = 0;
  private readonly localToolsByName: Map<string, LocalToolSpec>;
  private readonly sideEffectingTools: Set<string>;

  constructor(
    private readonly claude: ClaudeClient,
    private readonly mcp: MercuryMcpConnection,
    private readonly systemPrompt: string,
    private readonly context: CaseContext,
    private readonly localTools: LocalToolSpec[] = []
  ) {
    this.localToolsByName = new Map(localTools.map((t) => [t.name, t]));
    this.sideEffectingTools = new Set([
      ...toolSpecs.filter((t) => t.sideEffecting).map((t) => t.name),
      ...localTools.filter((t) => t.sideEffecting).map((t) => t.name),
    ]);
  }

  /**
   * `resumeTranscript`, when provided (from SessionManager.resumeSession),
   * seeds the conversation with a prior session's messages before appending
   * `initialUserMessage` as the new turn — this is the resume-session path.
   */
  async run(initialUserMessage: string, resumeTranscript: ClaudeMessageParam[] = []): Promise<LoopResult> {
    const messages: ClaudeMessageParam[] = [...resumeTranscript, { role: "user", content: initialUserMessage }];
    const trace: TraceEntry[] = [];
    const mcpToolDefs = await this.mcp.listToolDefinitions();
    const toolDefs = [
      ...mcpToolDefs,
      ...this.localTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    ];

    let iteration = 0;
    while (true) {
      iteration += 1;
      if (iteration > config.maxLoopIterations) {
        return this.finalize("max_iterations_exceeded", trace, messages, iteration);
      }
      if (iteration === config.maxLoopIterations) {
        messages.push({
          role: "user",
          content:
            `This is your final turn before the loop's iteration limit (${config.maxLoopIterations}). ` +
            "If the case is not fully resolved, call escalate_to_human now with whatever facts you have.",
        });
      }

      const response = await this.claude.createMessage({
        model: config.model,
        system: this.systemPrompt,
        messages,
        tools: toolDefs,
      });

      const toolUseBlocks = response.content.filter((b): b is ClaudeToolUseBlock => b.type === "tool_use");
      const traceEntry: TraceEntry = {
        iteration,
        stopReason: response.stopReason,
        assistantContent: response.content,
        toolCalls: [],
      };
      trace.push(traceEntry);
      messages.push({ role: "assistant", content: response.content });

      if (toolUseBlocks.length === 0) {
        if (this.context.escalationStatus !== "none") {
          return this.finalize(
            this.context.escalationStatus === "resolved" ? "resolve_case" : "escalate_to_human",
            trace,
            messages,
            iteration
          );
        }
        messages.push({
          role: "user",
          content:
            "Every case must end by calling either resolve_case (autonomous resolution) or " +
            "escalate_to_human (handoff) — you have called neither yet. Continue working the case, " +
            "or if you already have enough information, call one of those two tools now.",
        });
        continue;
      }

      const { blocks: resultBlocks, stuck, terminal } = await this.executeToolUseBlocks(toolUseBlocks, traceEntry);
      messages.push({ role: "user", content: resultBlocks });

      if (stuck) {
        return this.finalize("duplicate_tool_call_loop", trace, messages, iteration);
      }
      if (terminal === "output_exhausted") {
        return this.finalize("structured_output_retry_exhausted", trace, messages, iteration);
      }
      if (terminal === "resolved") {
        return this.finalize("resolve_case", trace, messages, iteration);
      }
      if (terminal === "escalated") {
        return this.finalize("escalate_to_human", trace, messages, iteration);
      }
    }
  }

  private async executeToolUseBlocks(
    toolUseBlocks: ClaudeToolUseBlock[],
    traceEntry: TraceEntry
  ): Promise<{
    blocks: ClaudeToolResultBlock[];
    stuck: boolean;
    terminal: "resolved" | "escalated" | "output_exhausted" | null;
  }> {
    const blocks: ClaudeToolResultBlock[] = [];
    let stuck = false;
    let terminal: "resolved" | "escalated" | "output_exhausted" | null = null;

    const anySideEffecting = toolUseBlocks.some((b) => this.sideEffectingTools.has(b.name));

    const runOne = async (toolUse: ClaudeToolUseBlock): Promise<ClaudeToolResultBlock> => {
      const signature = `${toolUse.name}:${stableStringify(toolUse.input)}`;
      const count = (this.signatureCounts.get(signature) ?? 0) + 1;
      this.signatureCounts.set(signature, count);
      if (count >= MAX_IDENTICAL_TOOL_CALLS) {
        stuck = true;
        traceEntry.toolCalls.push({ name: toolUse.name, input: toolUse.input, success: false, attempts: 0, blockedByHook: false });
        return toolResultBlock(
          toolUse.id,
          {
            success: false,
            error: {
              errorCode: "DUPLICATE_TOOL_CALL_LOOP",
              errorCategory: "INTERNAL",
              message:
                `The exact call ${toolUse.name}(${JSON.stringify(toolUse.input)}) has been repeated ` +
                `${count} times with no new information. Stop retrying this and escalate the case instead.`,
              isRetryable: false,
            },
          },
          true
        );
      }

      if (TERMINAL_TOOLS.has(toolUse.name)) {
        return this.handleTerminalToolUse(toolUse, traceEntry, (t) => {
          terminal = t;
        });
      }

      const localTool = this.localToolsByName.get(toolUse.name);
      if (localTool) {
        const result = await localTool.handler(toolUse.input, this.context);
        traceEntry.toolCalls.push({ name: toolUse.name, input: toolUse.input, success: result.success, attempts: 1, blockedByHook: false });
        this.context.ingest(
          { toolName: toolUse.name, input: toolUse.input, result, attempts: 1, blockedByHook: false, forceEscalation: false },
          toolUse.id
        );
        return toolResultBlock(toolUse.id, result, !result.success);
      }

      const outcome = await executeTool(this.mcp, toolUse.name, toolUse.input, this.context.toHookContext());
      this.context.ingest(outcome, toolUse.id);
      traceEntry.toolCalls.push({
        name: toolUse.name,
        input: toolUse.input,
        success: outcome.result.success,
        attempts: outcome.attempts,
        blockedByHook: outcome.blockedByHook,
      });

      // record_case_facts is structured output too (spec section 11/12): schema
      // validation already ran at the MCP layer; this is the semantic gate
      // (line_item_refund_sum == requested_refund_total). Non-terminal — a
      // failure here just becomes a tool_result error Claude can correct on
      // its own next turn, bounded by the loop's own max-iteration/duplicate-
      // call safety nets rather than a separate retry counter.
      if (toolUse.name === "record_case_facts" && outcome.result.success) {
        const semantic = validateCaseFacts(toolUse.input as CaseFacts);
        if (!semantic.valid) {
          return toolResultBlock(toolUse.id, formatValidationErrorsForClaude(toolUse.name, semantic.errors), true);
        }
      }

      const projected = this.context.projectForClaude(toolUse.name, outcome.result as Record<string, unknown>);
      return toolResultBlock(toolUse.id, projected, !outcome.result.success);
    };

    if (anySideEffecting) {
      for (const toolUse of toolUseBlocks) {
        blocks.push(await runOne(toolUse));
      }
    } else {
      const results = await Promise.all(toolUseBlocks.map(runOne));
      blocks.push(...results);
    }

    return { blocks, stuck, terminal };
  }

  private async handleTerminalToolUse(
    toolUse: ClaudeToolUseBlock,
    traceEntry: TraceEntry,
    setTerminal: (t: "resolved" | "escalated" | "output_exhausted") => void
  ): Promise<ClaudeToolResultBlock> {
    const outcome = await executeTool(this.mcp, toolUse.name, toolUse.input, this.context.toHookContext());
    this.context.ingest(outcome, toolUse.id);
    traceEntry.toolCalls.push({
      name: toolUse.name,
      input: toolUse.input,
      success: outcome.result.success,
      attempts: outcome.attempts,
      blockedByHook: outcome.blockedByHook,
    });

    if (!outcome.result.success) {
      return this.handleOutputRetry(toolUse, JSON.stringify(outcome.result), setTerminal);
    }

    const semantic =
      toolUse.name === "resolve_case"
        ? validateResolution(toolUse.input as Resolution, this.context)
        : validateEscalationPacket(toolUse.input as EscalationPacket, this.context);

    if (!semantic.valid) {
      return this.handleOutputRetry(
        toolUse,
        formatValidationErrorsForClaude(toolUse.name, semantic.errors),
        setTerminal
      );
    }

    // Only now — schema AND semantic validation both passed — does the case
    // actually count as resolved/escalated (see the comment in
    // CaseContext.ingest's resolve_case/escalate_to_human cases).
    if (toolUse.name === "resolve_case") {
      this.context.resolutionOutcome = "resolved_autonomously";
      this.context.escalationStatus = "resolved";
    } else {
      this.context.escalationStatus = "escalated";
      const escalationId = (outcome.result as { escalationId?: string }).escalationId;
      if (escalationId) this.context.escalationId = escalationId;
    }

    setTerminal(toolUse.name === "resolve_case" ? "resolved" : "escalated");
    return toolResultBlock(toolUse.id, outcome.result, false);
  }

  private handleOutputRetry(
    toolUse: ClaudeToolUseBlock,
    message: string,
    setTerminal: (t: "output_exhausted") => void
  ): ClaudeToolResultBlock {
    if (this.outputRetriesUsed >= config.maxOutputRetries) {
      setTerminal("output_exhausted");
      return toolResultBlock(toolUse.id, message, true);
    }
    this.outputRetriesUsed += 1;
    return toolResultBlock(toolUse.id, message, true);
  }

  /**
   * Ends the loop. If neither resolve_case nor escalate_to_human already
   * succeeded (i.e. we hit a safety valve: max iterations, a detected
   * duplicate-call loop, or exhausted output-validation retries), this files
   * a fail-safe escalation built entirely from CaseContext — never from an
   * unvalidated Claude turn — so every run still ends with an auditable
   * handoff instead of silently dropping the case.
   */
  private async finalize(
    reason: LoopResult["terminationReason"],
    trace: TraceEntry[],
    transcript: ClaudeMessageParam[],
    iterations: number
  ): Promise<LoopResult> {
    if (this.context.escalationStatus === "none") {
      await this.fileFailSafeEscalation(reason);
    }
    const outcome: LoopResult["outcome"] = this.context.resolutionOutcome === "resolved_autonomously" ? "resolved" : "escalated";
    return { outcome, terminationReason: reason, iterations, trace, context: this.context, transcript };
  }

  private async fileFailSafeEscalation(reason: LoopResult["terminationReason"]): Promise<void> {
    const ctx = this.context;
    const packet = {
      caseId: ctx.caseId,
      traceId: ctx.traceId,
      customerSummary:
        "We were unable to fully resolve your request automatically and have passed it to a specialist.",
      internalSummary: `Automated loop safety valve triggered: ${reason}.`,
      identityState: ctx.identityStatus,
      orderFacts: ctx.orderId ? { orderId: ctx.orderId } : null,
      paymentFacts: ctx.knownRemainingRefundableAmount
        ? { remainingRefundableAmount: ctx.knownRemainingRefundableAmount }
        : null,
      requestedAction: "information_only" as const,
      requestedAmount: null,
      eligibleAmount: null,
      policyDecision: "undetermined" as const,
      policyCitations: [...ctx.seenPolicyCitations.values()],
      policyVersion: null,
      policyEffectiveDate: null,
      confidence: "low" as const,
      ambiguities: [`Automated resolution did not converge (${reason}).`],
      riskFlags: ["missing_provenance" as const],
      actionsAlreadyTaken: ctx.actionsTaken,
      toolFailures: ctx.toolFailures,
      escalationReason: `Fail-safe: ${reason}. See internal summary and tool failure log for detail.`,
      recommendedHumanAction: "Manually review the case transcript and audit trail before taking any action.",
      provenance: ctx.provenance,
    };

    const outcome = await executeTool(this.mcp, "escalate_to_human", packet, ctx.toHookContext());
    ctx.ingest(outcome, "failsafe");
    if (outcome.result.success) {
      ctx.escalationStatus = "escalated";
      const escalationId = (outcome.result as { escalationId?: string }).escalationId;
      if (escalationId) ctx.escalationId = escalationId;
    }
  }
}
