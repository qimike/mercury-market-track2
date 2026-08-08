#!/usr/bin/env node
/**
 * Track 2 demonstration CLI (spec section 42). Every subcommand operates
 * against the in-memory mock backends — nothing here talks to a real
 * payment processor, CRM, or ticketing system. `demo-seed` builds a real
 * suggestion packet from ACTUAL mock-backend calls (no fabricated data) and
 * requires no ANTHROPIC_API_KEY; `submit` runs the real advisor loop and
 * does require one (RealClaudeClient). See docs/demo-guide.md for a full
 * walkthrough.
 */

import { randomUUID } from "node:crypto";
import { getCustomer } from "../mock-backends/crm.js";
import { verifyCustomerIdentity } from "../mock-backends/identity.js";
import { lookupOrder } from "../mock-backends/oms.js";
import { getPaymentHistory } from "../mock-backends/payments.js";
import { evaluatePolicy } from "../mock-backends/policy.js";
import { buildSuggestionPacket } from "../domain/schemas/suggestionPacket.js";
import { recordSuggestionPacket, getSuggestionPacket } from "../advisor/packetStore.js";
import { deriveRationale } from "../advisor/rationale.js";
import { approveAction, editAction, rejectAction, requestRevision, addReviewerComment } from "../approvals/decide.js";
import { executeApprovedAction } from "../approvals/execute.js";
import { buildAuditTimeline } from "../audit/auditLog.js";
import { getScratchpad, recordScratchpadEntry } from "../sessions/scratchpad.js";
import { SessionManager } from "../sessions/index.js";
import { runAdvisor } from "../advisor/orchestrator.js";
import { RealClaudeClient } from "../agent/claudeClient.js";
import { runGovernanceReview, loadPriorFindings, savePriorFindings, compareAgainstPrior } from "../governance/ciReview.js";
import { loadState, saveState } from "./persistence.js";

const sessions = new SessionManager();

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function cmdDemoSeed(): Promise<void> {
  const caseId = "case_demo_001";
  const sessionId = "sess_demo_001";
  const customerId = "cust_001";
  const orderId = "ord_1001";

  if (!sessions.getSession(sessionId)) {
    sessions.createSession(caseId, sessionId, sessionId);
  }

  const customer = await getCustomer(customerId);
  const verify = await verifyCustomerIdentity(customerId, "94107");
  const order = await lookupOrder(orderId, customerId);
  const payment = await getPaymentHistory(orderId);
  const asOfDate = new Date().toISOString().slice(0, 10);
  const policy = await evaluatePolicy({
    region: "US",
    sku: "HOME-MUG-01",
    issueType: "return",
    deliveryDate: order.success ? order.order.deliveryDate : null,
    asOfDate,
    traceId: sessionId,
  });

  if (!customer.success || !verify.success || !order.success || !payment.success || !policy.success) {
    console.error("demo-seed: a mock backend call failed unexpectedly — cannot build a real demo packet.");
    process.exitCode = 1;
    return;
  }

  const eligible = policy.decision === "eligible" || policy.decision === "partially_eligible";
  const amount = order.order.amountPaid; // decimal string, e.g. "45.00"

  const packet = buildSuggestionPacket({
    caseId,
    sessionId,
    customerIntent: "Customer requests a return/refund for a delivered item.",
    caseSummary: `Order ${orderId}: ${order.order.lineItems.map((li) => li.description).join(", ")}.`,
    identityStatus: verify.identityStatus === "verified" ? "verified" : "unavailable",
    issues: [
      {
        issueId: "issue_1",
        issueType: "return",
        analysisSummary: `Policy evaluation returned decision="${policy.decision}" at confidence="${policy.confidence}".`,
        decision: eligible ? (policy.decision as "eligible" | "partially_eligible") : "ineligible",
        confidence: policy.confidence === "high" ? 0.92 : policy.confidence === "medium" ? 0.6 : 0.3,
        customerClaimReferences: ["customer_claim_1"],
        verifiedFactReferences: ["order_lookup_1", "payment_history_1"],
        policyCitationReferences: eligible ? policy.citations.map((c) => c.policyId) : [],
        missingInformation: [],
        risks: payment.refunds.length > 0 ? ["Prior refunds exist on this order — confirm no double compensation."] : [],
      },
    ],
    integratedRecommendation: {
      recommendedOutcome: eligible ? "Approve a refund for the returned item." : "Do not propose a refund — policy did not return a clear eligible decision.",
      customerFacingDraft: eligible
        ? `We've reviewed your order and a refund of ${amount} ${order.order.currency} is recommended pending human approval.`
        : "We're still reviewing your request and will follow up shortly.",
      internalSummary: `Order ${orderId} reviewed against ${policy.citations.map((c) => `${c.policyId}@v${c.version}`).join(", ") || "no applicable citation"}.`,
      conflictsDetected: policy.conflicts.map((c) => c.description),
      unresolvedQuestions: eligible ? [] : ["Policy decision was not a clear eligible/partially_eligible outcome."],
    },
    proposedActions: eligible
      ? [
          {
            actionId: "action_1",
            actionType: "propose_refund",
            description: `Refund ${amount} ${order.order.currency} for order ${orderId}.`,
            parameters: { orderId, customerId, amount, currency: order.order.currency, reason: "Eligible return per policy citation." },
            executionStatus: "awaiting_approval",
            preconditions: ["Verified customer", "Policy citation eligible", "Amount within remaining refundable balance"],
            blockingIssues: [],
            idempotencyKey: null,
          },
        ]
      : [],
    policyCitations: policy.citations.map((c) => ({
      policyId: c.policyId,
      title: c.title,
      version: c.version,
      effectiveFrom: c.effectiveDate,
      effectiveTo: c.expirationDate,
      sourceReference: c.provenance.sourceId,
      relevantClauses: [c.excerpt],
      retrievedAt: c.provenance.retrievedAt,
    })),
    dataProvenance: [
      { sourceType: "crm", sourceReference: customerId, retrievedAt: new Date().toISOString(), toolCallId: null, correlationId: sessionId },
      { sourceType: "oms", sourceReference: orderId, retrievedAt: new Date().toISOString(), toolCallId: null, correlationId: sessionId },
      { sourceType: "payments", sourceReference: orderId, retrievedAt: new Date().toISOString(), toolCallId: null, correlationId: sessionId },
      ...policy.citations.map((c) => ({ sourceType: "policy" as const, sourceReference: c.policyId, retrievedAt: c.provenance.retrievedAt, toolCallId: null, correlationId: sessionId })),
    ],
    review: { status: eligible ? "pass" : "pass_with_notes", blockingFindings: [], nonBlockingFindings: eligible ? [] : ["No eligible policy decision — packet recommends no action."], reviewedAt: new Date().toISOString() },
    overallConfidence: policy.confidence === "high" ? 0.9 : policy.confidence === "medium" ? 0.6 : 0.3,
  });

  recordSuggestionPacket(packet);
  recordScratchpadEntry({
    caseId,
    sessionId,
    category: "verified_insight",
    statement: `Policy decision for ${orderId}: ${policy.decision} (confidence ${policy.confidence}).`,
    status: "verified",
    sourceReferences: policy.citations.map((c) => c.policyId),
    creatorType: "advisor_agent",
    creatorReference: "demo-seed",
  });

  console.log(`Seeded suggestion packet "${packet.suggestionId}" for case "${caseId}" (${eligible ? "eligible" : "not eligible"}).`);
  printJson(packet);
}

async function cmdSubmit(message: string, caseId: string, sessionId: string): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("submit requires ANTHROPIC_API_KEY (real reasoning). Use `demo-seed` for a credential-free walkthrough.");
    process.exitCode = 1;
    return;
  }
  const claude = new RealClaudeClient();
  const result = await runAdvisor({ claude, caseId, sessionId, initialUserMessage: message });
  printJson({ outcome: result.loopResult.outcome, terminationReason: result.loopResult.terminationReason, suggestionPacket: result.suggestionPacket });
}

async function cmdPacket(suggestionId: string): Promise<void> {
  const packet = getSuggestionPacket(suggestionId);
  if (!packet) return void console.error(`No packet "${suggestionId}".`);
  printJson(packet);
}

async function cmdRationale(suggestionId: string): Promise<void> {
  const packet = getSuggestionPacket(suggestionId);
  if (!packet) return void console.error(`No packet "${suggestionId}".`);
  printJson(deriveRationale(packet));
}

async function cmdApprove(suggestionId: string, actionId: string, reviewerId: string, comment?: string): Promise<void> {
  printJson(approveAction(suggestionId, actionId, reviewerId, comment ?? null));
}

async function cmdEdit(suggestionId: string, actionId: string, parametersJson: string): Promise<void> {
  printJson(editAction(suggestionId, actionId, { parameters: JSON.parse(parametersJson) }));
}

async function cmdReject(suggestionId: string, actionId: string, reviewerId: string, comment: string): Promise<void> {
  printJson(rejectAction(suggestionId, actionId, reviewerId, comment));
}

async function cmdRevise(suggestionId: string, reviewerId: string, comment: string): Promise<void> {
  printJson(requestRevision(suggestionId, reviewerId, comment));
}

async function cmdComment(suggestionId: string, comment: string): Promise<void> {
  printJson(addReviewerComment(suggestionId, comment));
}

async function cmdExecute(suggestionId: string, actionId: string, humanActorId: string): Promise<void> {
  printJson(await executeApprovedAction({ suggestionId, actionId, humanActorId }));
}

async function cmdAudit(caseId: string): Promise<void> {
  printJson(await buildAuditTimeline(caseId));
}

async function cmdScratchpad(caseId: string): Promise<void> {
  printJson(getScratchpad(caseId));
}

async function cmdSessionStart(caseId: string): Promise<void> {
  const record = sessions.createSession(caseId);
  printJson(record);
}

async function cmdResume(sessionId: string): Promise<void> {
  const record = sessions.resumeSession(sessionId);
  printJson({ sessionId: record.sessionId, status: record.status, transcriptLength: record.transcript.length });
}

async function cmdFork(sessionId: string, purpose: string): Promise<void> {
  const fork = sessions.forkSession(sessionId, purpose);
  printJson(fork);
}

async function cmdGovernance(): Promise<void> {
  const { review, modelAssisted } = await runGovernanceReview({ reviewType: "integrated", reviewedFiles: ["policies/", "src/domain/roles.ts", "src/mcp/toolDefinitions.ts"] });
  const prior = await loadPriorFindings();
  const comparison = compareAgainstPrior(review.findings, prior);
  await savePriorFindings(review.findings);
  printJson({ review, modelAssisted, comparison: { fresh: comparison.fresh.length, stillActive: comparison.stillActive.length, fixed: comparison.fixed.length } });
  if (review.status === "fail") process.exitCode = 1;
}

function printHelp(): void {
  console.log(`Mercury Market Track 2 advisor CLI (synthetic data only)

Usage: tsx src/cli/index.ts <command> [args]

  demo-seed                                          Build a real suggestion packet from live mock data (no API key needed)
  submit "<message>" <caseId> <sessionId>            Run the real advisor loop (requires ANTHROPIC_API_KEY)
  packet <suggestionId>                              Print a suggestion packet
  rationale <suggestionId>                           Print the derived internal rationale
  approve <suggestionId> <actionId> <reviewerId> [comment]
  edit <suggestionId> <actionId> <parametersJson>
  reject <suggestionId> <actionId> <reviewerId> <comment>
  revise <suggestionId> <reviewerId> <comment>
  comment <suggestionId> <comment>
  execute <suggestionId> <actionId> <humanActorId>   Only works after approve
  audit <caseId>                                     Print the audit timeline
  scratchpad <caseId>                                Print the investigation scratchpad
  session-start <caseId>                             Create a session (prints sessionId) so resume/fork have something to target
  resume <sessionId>
  fork <sessionId> <purpose>
  governance                                         Run local CI governance checks
`);
}

async function dispatch(command: string | undefined, args: string[]): Promise<void> {
  switch (command) {
    case "demo-seed":
      return cmdDemoSeed();
    case "session-start":
      return cmdSessionStart(args[0]!);
    case "submit":
      return cmdSubmit(args[0] ?? "", args[1] ?? `case_${randomUUID().slice(0, 8)}`, args[2] ?? `sess_${randomUUID().slice(0, 8)}`);
    case "packet":
      return cmdPacket(args[0]!);
    case "rationale":
      return cmdRationale(args[0]!);
    case "approve":
      return cmdApprove(args[0]!, args[1]!, args[2]!, args[3]);
    case "edit":
      return cmdEdit(args[0]!, args[1]!, args[2]!);
    case "reject":
      return cmdReject(args[0]!, args[1]!, args[2]!, args[3]!);
    case "revise":
      return cmdRevise(args[0]!, args[1]!, args[2]!);
    case "comment":
      return cmdComment(args[0]!, args[1]!);
    case "execute":
      return cmdExecute(args[0]!, args[1]!, args[2]!);
    case "audit":
      return cmdAudit(args[0]!);
    case "scratchpad":
      return cmdScratchpad(args[0]!);
    case "resume":
      return cmdResume(args[0]!);
    case "fork":
      return cmdFork(args[0]!, args[1] ?? "unspecified");
    case "governance":
      return cmdGovernance();
    default:
      printHelp();
  }
}

const READ_ONLY_COMMANDS = new Set(["packet", "rationale", "audit", "scratchpad", "governance", "submit", undefined]);

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  // Suggestion packets and approval records are per-process in-memory stores
  // (kept that way so tests stay hermetic); this CLI snapshots them to
  // .mercury-state/ (gitignored) so a multi-step demo (seed -> approve ->
  // execute -> audit) works across separate `tsx` invocations. Session
  // resume/fork state is intentionally NOT persisted this way — see
  // docs/demo-guide.md for why.
  await loadState(sessions);
  await dispatch(command, args);
  if (!READ_ONLY_COMMANDS.has(command)) await saveState(sessions);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
