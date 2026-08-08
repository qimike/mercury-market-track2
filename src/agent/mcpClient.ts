/**
 * Connects the agent loop to the real Mercury Market MCP server over an
 * in-memory transport (no subprocess): the loop's tool executor talks the
 * actual Model Context Protocol, not a hand-rolled function-call shortcut.
 * The same server factory (src/mcp/server.ts) backs both this in-process
 * client and the stdio entrypoint used by external MCP clients.
 */

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMercuryMcpServer } from "../mcp/server.js";
import { err, type ToolResult } from "../domain/errors.js";
import type { Role } from "../domain/roles.js";

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MercuryMcpConnection {
  traceId: string;
  listToolDefinitions(): Promise<AnthropicToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult<Record<string, unknown>>>;
  readResource(uri: string): Promise<string>;
  close(): Promise<void>;
}

export async function connectMercuryMcp(options: {
  traceId?: string;
  readOnlySession: boolean;
  /**
   * Defaults to "advisor_agent" — the only role src/agent's own loop ever
   * uses. A "human_support_agent" connection is opened exclusively by
   * src/approvals/execute.ts, never by the advisor loop itself.
   */
  callerRole?: Role;
  sessionId?: string;
}): Promise<MercuryMcpConnection> {
  const traceId = options.traceId ?? randomUUID();
  const server = createMercuryMcpServer({
    traceId,
    readOnlySession: options.readOnlySession,
    callerRole: options.callerRole ?? "advisor_agent",
    sessionId: options.sessionId,
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mercury-agent-loop", version: "0.1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    traceId,
    async listToolDefinitions() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
    },
    async callTool(name, args) {
      try {
        const result = await client.callTool({ name, arguments: args });
        const contentBlock = Array.isArray(result.content) ? result.content[0] : undefined;
        if (contentBlock && contentBlock.type === "text" && typeof contentBlock.text === "string") {
          try {
            return JSON.parse(contentBlock.text) as ToolResult<Record<string, unknown>>;
          } catch {
            // Not our JSON envelope — typically the MCP layer itself rejected the
            // call (e.g. input failed inputSchema validation before our handler
            // ever ran). Surface the raw text as a VALIDATION error rather than
            // silently discarding it.
            if (result.isError) {
              return {
                success: false,
                error: err("VALIDATION", "TOOL_INPUT_REJECTED", contentBlock.text, false),
              };
            }
          }
        }
        if (result.structuredContent) {
          return result.structuredContent as unknown as ToolResult<Record<string, unknown>>;
        }
        return {
          success: false,
          error: err("INTERNAL", "MALFORMED_TOOL_RESPONSE", `Tool "${name}" returned no parseable content.`, false),
        };
      } catch (error) {
        // MCP protocol-level failure: typically bad input args (schema rejection)
        // or a transport error. Surface as a structured VALIDATION/DEPENDENCY error
        // instead of throwing across the agent loop boundary.
        const message = error instanceof Error ? error.message : String(error);
        const isSchemaRejection = /invalid|schema|parse/i.test(message);
        return {
          success: false,
          error: err(
            isSchemaRejection ? "VALIDATION" : "DEPENDENCY",
            isSchemaRejection ? "TOOL_INPUT_REJECTED" : "MCP_TRANSPORT_ERROR",
            message,
            !isSchemaRejection
          ),
        };
      }
    },
    async readResource(uri) {
      const result = await client.readResource({ uri });
      const first = result.contents[0];
      return first && "text" in first && typeof first.text === "string" ? first.text : "";
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
