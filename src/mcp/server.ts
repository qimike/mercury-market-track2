/**
 * The Mercury Market MCP server: registers every tool in toolDefinitions.ts
 * and every resource in resourceDefinitions.ts on a single McpServer instance.
 *
 * `createMercuryMcpServer` is the shared factory used both by:
 *  - this file's stdio entrypoint (registered in .mcp.json, usable by Claude
 *    Code / Claude Desktop / any MCP client), and
 *  - the in-process agent (src/agent/mcpClient.ts), which connects to a fresh
 *    instance over an in-memory transport so the agent loop talks to these
 *    tools through the real MCP protocol without a subprocess.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toolSpecs, type ToolContext } from "./toolDefinitions.js";
import { resourceSpecs } from "./resourceDefinitions.js";

export interface MercuryServerOptions {
  traceId: string;
  readOnlySession: boolean;
}

export function createMercuryMcpServer(options: MercuryServerOptions): McpServer {
  const server = new McpServer({
    name: "mercury-market",
    version: "0.1.0",
    title: "Mercury Market Customer Resolution Tools",
  });

  let callCounter = 0;

  for (const spec of toolSpecs) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: `${spec.description}\n\nBoundaries: ${spec.boundaries}\n\nExamples:\n${spec.examples
          .map((e) => `- ${e}`)
          .join("\n")}`,
        inputSchema: spec.inputShape,
        outputSchema: spec.outputShape,
        annotations: {
          readOnlyHint: !spec.sideEffecting,
          destructiveHint: spec.sideEffecting,
          idempotentHint: spec.name === "process_refund" || spec.name === "verify_customer_identity",
        },
      },
      async (args: unknown) => {
        callCounter += 1;
        const ctx: ToolContext = {
          traceId: options.traceId,
          readOnlySession: options.readOnlySession,
        };
        const result = await spec.handler(args, ctx);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
          isError: !result.success,
        };
      }
    );
  }

  for (const resource of resourceSpecs) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: resource.mimeType },
      async () => ({
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.read() }],
      })
    );
  }

  return server;
}

async function main(): Promise<void> {
  const server = createMercuryMcpServer({
    traceId: `stdio-${Date.now()}`,
    readOnlySession: false,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error("Mercury MCP server failed to start:", error);
    process.exit(1);
  });
}
