/**
 * Local runner for the Mercury Market coordinator.
 *
 * Demo mode (default, no API key required):
 *   npm run agent:cli -- --scenario eligible_low_value_refund
 * Runs a seeded scenario through the real coordinator/subagent/hooks stack
 * using the deterministic autopilot in place of a live model — useful for
 * seeing the whole system work without any credentials.
 *
 * Live mode (requires ANTHROPIC_API_KEY):
 *   npm run agent:cli -- --live "Customer cust_001 wants to return order ord_1001"
 * Runs the coordinator with the real Anthropic API driving every decision.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { connectMercuryMcp } from "./agent/mcpClient.js";
import { FakeClaudeClient, RealClaudeClient } from "./agent/claudeClient.js";
import { runCoordinator } from "./agent/coordinator.js";
import { createAutopilot } from "./eval/autopilot.js";
import { scenarios } from "./eval/scenarios.js";
import { getResolution } from "./mock-backends/caseManagement.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const liveIndex = args.indexOf("--live");
  const traceId = randomUUID();
  const mcp = await connectMercuryMcp({ traceId, readOnlySession: false });

  if (liveIndex !== -1) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("Live mode requires ANTHROPIC_API_KEY to be set. See .env.example.");
      process.exit(1);
    }
    const message = args[liveIndex + 1] ?? "A customer needs help.";
    const caseId = `case_live_${Date.now()}`;
    const claude = new RealClaudeClient();
    const result = await runCoordinator({ claude, mcp, caseId, traceId, initialUserMessage: message });
    printResult(caseId, result);
    writeTraceLog(caseId, result);
    await mcp.close();
    return;
  }

  const scenarioIndex = args.indexOf("--scenario");
  const scenarioId = scenarioIndex !== -1 ? args[scenarioIndex + 1] : "eligible_low_value_refund";
  const scenario = scenarios.find((s) => s.id === scenarioId);
  if (!scenario) {
    console.error(`Unknown scenario "${scenarioId}". Available: ${scenarios.map((s) => s.id).join(", ")}`);
    await mcp.close();
    process.exit(1);
  }

  console.log(`Running demo scenario "${scenario!.id}": ${scenario!.description}\n`);
  const claude = new FakeClaudeClient(createAutopilot(scenario!.input));
  const result = await runCoordinator({
    claude,
    mcp,
    caseId: scenario!.input.caseId,
    traceId,
    initialUserMessage: `Customer ${scenario!.input.customerId} requests a ${scenario!.input.issueType} for ` +
      `order ${scenario!.input.orderId}. Reason: ${scenario!.input.reason}`,
  });
  printResult(scenario!.input.caseId, result);
  writeTraceLog(scenario!.input.caseId, result);
  await mcp.close();
}

/**
 * Dumps the run's trace to logs/<caseId>.jsonl — one JSON line per loop
 * iteration, each with its tool calls (name/input/success/attempts/
 * blockedByHook). This is the log format the verbose-log-analysis skill
 * (.claude/skills/verbose-log-analysis/SKILL.md) expects to analyze.
 */
function writeTraceLog(caseId: string, result: Awaited<ReturnType<typeof runCoordinator>>): void {
  mkdirSync("logs", { recursive: true });
  const lines = result.trace.map((entry) => JSON.stringify(entry));
  const path = `logs/${caseId}.jsonl`;
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  console.log(`Trace log written to ${path}`);
}

function printResult(caseId: string, result: Awaited<ReturnType<typeof runCoordinator>>): void {
  console.log(`Outcome: ${result.outcome}`);
  console.log(`Termination reason: ${result.terminationReason}`);
  console.log(`Loop iterations: ${result.iterations}`);
  console.log(`Actions taken: ${result.context.actionsTaken.join("; ") || "(none)"}`);
  if (result.outcome === "resolved") {
    const resolution = getResolution(caseId);
    console.log(`Resolution: ${JSON.stringify(resolution, null, 2)}`);
  } else {
    console.log(`Escalation id: ${result.context.escalationId}`);
  }
}

main().catch((error) => {
  console.error("CLI run failed:", error);
  process.exit(1);
});
