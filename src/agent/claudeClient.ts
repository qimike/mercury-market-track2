/**
 * Thin Claude client abstraction used by the deterministic agent loop
 * (src/agent/loop.ts). Two implementations:
 *
 *  - RealClaudeClient: wraps @anthropic-ai/sdk's Messages API for live runs
 *    (requires ANTHROPIC_API_KEY).
 *  - FakeClaudeClient: scripted, deterministic responses for tests and the
 *    evaluation harness. No network access, no live API key required — this
 *    is the default for everything under test/.
 *
 * The loop only depends on this narrow interface, never on the Anthropic SDK
 * directly, so tests can swap in FakeClaudeClient without touching loop.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicToolDef } from "./mcpClient.js";

export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ClaudeResponseBlock = ClaudeTextBlock | ClaudeToolUseBlock;

export interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ClaudeMessageContent = string | Array<ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock>;

export interface ClaudeMessageParam {
  role: "user" | "assistant";
  content: ClaudeMessageContent;
}

export type ClaudeStopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;

export interface ClaudeResponse {
  content: ClaudeResponseBlock[];
  stopReason: ClaudeStopReason;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ClaudeRequest {
  model: string;
  system: string;
  messages: ClaudeMessageParam[];
  tools: AnthropicToolDef[];
  maxTokens?: number;
}

export interface ClaudeClient {
  createMessage(request: ClaudeRequest): Promise<ClaudeResponse>;
}

export class RealClaudeClient implements ClaudeClient {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async createMessage(request: ClaudeRequest): Promise<ClaudeResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens ?? 2048,
      system: request.system,
      messages: request.messages as Anthropic.MessageParam[],
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      })),
    });

    const content: ClaudeResponseBlock[] = response.content.map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text };
      }
      if (block.type === "tool_use") {
        return { type: "tool_use", id: block.id, name: block.name, input: block.input as Record<string, unknown> };
      }
      return { type: "text", text: "" };
    });

    return {
      content,
      stopReason: response.stop_reason as ClaudeStopReason,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}

/**
 * Deterministic, offline Claude stand-in. Accepts either a fixed script
 * (array of responses, one per call) or a function of (callIndex, request)
 * for tests that need to assert on what was sent before deciding the next
 * scripted reply (e.g. "did the tool_result actually get appended?").
 */
export class FakeClaudeClient implements ClaudeClient {
  private callIndex = 0;
  readonly requests: ClaudeRequest[] = [];

  constructor(
    private readonly script: ClaudeResponse[] | ((callIndex: number, request: ClaudeRequest) => ClaudeResponse)
  ) {}

  async createMessage(request: ClaudeRequest): Promise<ClaudeResponse> {
    this.requests.push(request);
    const index = this.callIndex;
    this.callIndex += 1;
    if (typeof this.script === "function") {
      return this.script(index, request);
    }
    const response = this.script[index];
    if (!response) {
      throw new Error(
        `FakeClaudeClient exhausted its script at call ${index} (script length ${this.script.length}). ` +
          `The agent loop asked Claude for another turn than the test anticipated.`
      );
    }
    return response;
  }

  get callCount(): number {
    return this.callIndex;
  }
}
