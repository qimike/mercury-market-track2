/**
 * Evaluation harness (spec section 20). Runs every seeded scenario through
 * the real coordinator + subagents + hooks + validation stack, using the
 * deterministic autopilot (src/eval/autopilot.ts) in place of a live model,
 * and scores: correct resolution vs. escalation, tool usage, refund
 * accuracy, policy citation correctness, retry behavior, and average loop
 * iterations. Run with `npm run eval`.
 */

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { connectMercuryMcp } from "../agent/mcpClient.js";
import { FakeClaudeClient } from "../agent/claudeClient.js";
import { runCoordinator } from "../agent/coordinator.js";
import { createAutopilot } from "./autopilot.js";
import { scenarios } from "./scenarios.js";
import { getResolution, listEscalations } from "../mock-backends/caseManagement.js";
import { processRefund } from "../mock-backends/payments.js";

export interface ScenarioReport {
  id: string;
  description: string;
  expectedOutcome: "resolved" | "escalated";
  actualOutcome: "resolved" | "escalated";
  outcomeCorrect: boolean;
  reasonCorrect: boolean | null;
  iterations: number;
  terminationReason: string;
  toolsUsed: string[];
  toolFailures: number;
  idempotencyCheck: "n/a" | "pass" | "fail";
  /** No money moved on a case the scenario expected to be escalated (tool selection / forbidden tool usage). */
  noForbiddenSideEffect: boolean;
  /** For a resolved case with a refund, the executed amount matches exactly what was requested. */
  refundAmountAccurate: boolean | null;
  /** Every citation in the terminal packet (resolution or escalation) is one evaluate_policy actually returned. */
  citationsTraceable: boolean;
}

export async function runScenario(scenario: (typeof scenarios)[number]): Promise<ScenarioReport> {
  const traceId = randomUUID();
  const mcp = await connectMercuryMcp({ traceId, readOnlySession: false });
  const claude = new FakeClaudeClient(createAutopilot(scenario.input));

  const loopResult = await runCoordinator({
    claude,
    mcp,
    caseId: scenario.input.caseId,
    traceId,
    initialUserMessage: `Customer ${scenario.input.customerId} requests a ${scenario.input.issueType} for order ` +
      `${scenario.input.orderId}, SKU ${scenario.input.sku}, amount ${scenario.input.requestedAmount} ` +
      `${scenario.input.currency}. Reason: ${scenario.input.reason}`,
  });

  await mcp.close();

  let reasonCorrect: boolean | null = null;
  if (scenario.expectedReasonContains) {
    const escalation = listEscalations().find((e) => e.packet.caseId === scenario.input.caseId);
    const haystack = `${escalation?.packet.internalSummary ?? ""} ${escalation?.packet.escalationReason ?? ""}`.toLowerCase();
    reasonCorrect = haystack.includes(scenario.expectedReasonContains.toLowerCase());
  }

  let idempotencyCheck: ScenarioReport["idempotencyCheck"] = "n/a";
  if (scenario.id === "duplicate_refund_idempotency" && loopResult.outcome === "resolved") {
    const resolution = getResolution(scenario.input.caseId);
    if (resolution?.refundTransactionId) {
      const replay = await processRefund({
        orderId: scenario.input.orderId,
        customerId: scenario.input.customerId,
        amount: scenario.input.requestedAmount,
        currency: scenario.input.currency,
        reason: "idempotency replay check",
        idempotencyKey: `${scenario.input.caseId}:refund:${scenario.input.orderId}`,
      });
      idempotencyCheck =
        replay.success && replay.replayed && replay.transactionId === resolution.refundTransactionId ? "pass" : "fail";
    } else {
      idempotencyCheck = "fail";
    }
  }

  const resolution = getResolution(scenario.input.caseId);
  const escalation = listEscalations().find((e) => e.packet.caseId === scenario.input.caseId);

  // Tool selection / forbidden tool usage: a case the scenario expects to be
  // escalated must never have actually moved money.
  const noForbiddenSideEffect = !(scenario.expectedOutcome === "escalated" && resolution?.refundTransactionId);

  // Refund calculation accuracy: an executed refund must match the requested amount exactly.
  let refundAmountAccurate: boolean | null = null;
  if (resolution?.refundAmount) {
    refundAmountAccurate =
      resolution.refundAmount.amount === scenario.input.requestedAmount &&
      resolution.refundAmount.currency === scenario.input.currency;
  }

  // Policy citation correctness: every cited policy in the terminal packet was
  // actually returned by evaluate_policy this case (not fabricated).
  const citedIds = [
    ...(resolution?.policyCitations.map((c) => c.policyId) ?? []),
    ...(escalation?.packet.policyCitations.map((c) => c.policyId) ?? []),
  ];
  const citationsTraceable = citedIds.every((id) => loopResult.context.seenPolicyCitations.has(id));

  return {
    id: scenario.id,
    description: scenario.description,
    expectedOutcome: scenario.expectedOutcome,
    actualOutcome: loopResult.outcome,
    outcomeCorrect: loopResult.outcome === scenario.expectedOutcome,
    reasonCorrect,
    iterations: loopResult.iterations,
    terminationReason: loopResult.terminationReason,
    toolsUsed: [...new Set(loopResult.context.auditTrail.map((o) => o.toolName))],
    toolFailures: loopResult.context.toolFailures.length,
    idempotencyCheck,
    noForbiddenSideEffect,
    refundAmountAccurate,
    citationsTraceable,
  };
}

async function main(): Promise<void> {
  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    reports.push(await runScenario(scenario));
  }

  console.log("\n=== Mercury Market Evaluation Report ===\n");
  for (const r of reports) {
    const status =
      r.outcomeCorrect &&
      r.reasonCorrect !== false &&
      r.idempotencyCheck !== "fail" &&
      r.noForbiddenSideEffect &&
      r.refundAmountAccurate !== false &&
      r.citationsTraceable
        ? "PASS"
        : "FAIL";
    console.log(
      `[${status}] ${r.id} — expected ${r.expectedOutcome}, got ${r.actualOutcome} ` +
        `(termination: ${r.terminationReason}, iterations: ${r.iterations})`
    );
    if (r.reasonCorrect === false) console.log(`       reason substring check FAILED for "${r.description}"`);
    if (r.idempotencyCheck === "fail") console.log("       idempotency replay check FAILED");
    if (!r.noForbiddenSideEffect) console.log("       FORBIDDEN: a refund executed on a case expected to escalate");
    if (r.refundAmountAccurate === false) console.log("       refund amount did not match the requested amount");
    if (!r.citationsTraceable) console.log("       a cited policy was never actually returned by evaluate_policy");
    console.log(`       tools used: ${r.toolsUsed.join(", ")}`);
  }

  const totalCorrect = reports.filter((r) => r.outcomeCorrect).length;
  const reasonChecks = reports.filter((r) => r.reasonCorrect !== null);
  const reasonCorrectCount = reasonChecks.filter((r) => r.reasonCorrect).length;
  const avgIterations = reports.reduce((sum, r) => sum + r.iterations, 0) / reports.length;
  const idempotencyChecked = reports.find((r) => r.idempotencyCheck !== "n/a");
  const forbiddenSideEffects = reports.filter((r) => !r.noForbiddenSideEffect).length;
  const refundAccuracyChecks = reports.filter((r) => r.refundAmountAccurate !== null);
  const refundAccurateCount = refundAccuracyChecks.filter((r) => r.refundAmountAccurate).length;
  const citationsTraceableCount = reports.filter((r) => r.citationsTraceable).length;

  console.log("\n=== Summary ===");
  console.log(`Outcome correctness: ${totalCorrect}/${reports.length}`);
  console.log(`Escalation-reason correctness: ${reasonCorrectCount}/${reasonChecks.length}`);
  console.log(`Forbidden side effects (refund on an expected-escalation case): ${forbiddenSideEffects}/${reports.length}`);
  console.log(`Refund calculation accuracy: ${refundAccurateCount}/${refundAccuracyChecks.length}`);
  console.log(`Policy citation correctness (traceable to evaluate_policy): ${citationsTraceableCount}/${reports.length}`);
  console.log(`Average agent-loop iterations: ${avgIterations.toFixed(2)}`);
  console.log(`Idempotency replay check: ${idempotencyChecked?.idempotencyCheck ?? "n/a"}`);

  const anyFailure =
    totalCorrect !== reports.length ||
    reasonCorrectCount !== reasonChecks.length ||
    reports.some((r) => r.idempotencyCheck === "fail") ||
    forbiddenSideEffects > 0 ||
    refundAccurateCount !== refundAccuracyChecks.length ||
    citationsTraceableCount !== reports.length;

  if (anyFailure) {
    console.log("\nOne or more scenarios did not meet expectations — see FAIL lines above.");
    process.exitCode = 1;
  } else {
    console.log("\nAll scenarios met expectations.");
  }
}

// Guard so importing `runScenario`/`scenarios` from this module (e.g. from
// test/eval.test.ts) doesn't ALSO trigger a full eval run as a side effect —
// main() only runs when this file is executed directly (`npm run eval`).
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error("Evaluation run failed:", error);
    process.exit(1);
  });
}
