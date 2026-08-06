/**
 * Session and fork management (spec section 14). A "session" is one run of
 * the coordinator's AgentLoop against a case; its transcript can be resumed
 * later. A "fork" is a child investigation session that shares the parent's
 * caseId/traceId for correlation but gets its OWN CaseContext and — crucially
 * — its own MCP connection opened with `readOnlySession: true`, so side-
 * effecting tools (verify_customer_identity, create_return, process_refund)
 * are refused at the MCP layer itself (see forkGuard in
 * src/mcp/toolDefinitions.ts), not merely by convention. Findings from a fork
 * are never applied to the parent automatically — mergeFindingIntoParent is
 * an explicit, logged step.
 */

import { randomUUID } from "node:crypto";
import type { ClaudeMessageParam } from "./claudeClient.js";
import { CaseContext } from "./context.js";
import { connectMercuryMcp, type MercuryMcpConnection } from "./mcpClient.js";
import { evaluatePolicy } from "../mock-backends/policy.js";
import type { PolicyCitation } from "../domain/schemas.js";

export interface SessionRecord {
  sessionId: string;
  caseId: string;
  traceId: string;
  parentSessionId: string | null;
  kind: "main" | "fork";
  purpose: string | null;
  status: "active" | "completed";
  createdAt: string;
  transcript: ClaudeMessageParam[];
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  createSession(caseId: string, traceId: string = randomUUID()): SessionRecord {
    const record: SessionRecord = {
      sessionId: randomUUID(),
      caseId,
      traceId,
      parentSessionId: null,
      kind: "main",
      purpose: null,
      status: "active",
      createdAt: new Date().toISOString(),
      transcript: [],
    };
    this.sessions.set(record.sessionId, record);
    return record;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  saveTranscript(sessionId: string, transcript: ClaudeMessageParam[], status: "active" | "completed" = "active"): void {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session "${sessionId}".`);
    record.transcript = transcript;
    record.status = status;
  }

  /** Returns the transcript to seed AgentLoop.run's resumeTranscript parameter with. */
  resumeSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Cannot resume unknown session "${sessionId}".`);
    return record;
  }

  forkSession(parentSessionId: string, purpose: string): SessionRecord {
    const parent = this.sessions.get(parentSessionId);
    if (!parent) throw new Error(`Cannot fork unknown session "${parentSessionId}".`);
    const record: SessionRecord = {
      sessionId: randomUUID(),
      caseId: parent.caseId,
      traceId: parent.traceId,
      parentSessionId,
      kind: "fork",
      purpose,
      status: "active",
      createdAt: new Date().toISOString(),
      transcript: [],
    };
    this.sessions.set(record.sessionId, record);
    return record;
  }

  listChildren(parentSessionId: string): SessionRecord[] {
    return [...this.sessions.values()].filter((s) => s.parentSessionId === parentSessionId);
  }
}

export interface PolicyInvestigationFinding {
  forkSessionId: string;
  scenariosInspected: Array<{ sku: string; asOfDate: string; decision: string; confidence: string }>;
  conflictsFound: boolean;
  citations: PolicyCitation[];
  summary: string;
}

/**
 * The spec's worked example: a policy investigation fork that inspects
 * several (sku, asOfDate) scenarios read-only, detects conflicts, and returns
 * a structured finding for the parent session to decide whether to merge.
 * Uses its own read-only MCP connection — it CANNOT call process_refund,
 * create_return, or verify_customer_identity even if asked to.
 */
export async function investigatePolicyFork(
  sessions: SessionManager,
  parentSessionId: string,
  region: string,
  scenarios: Array<{ sku: string; asOfDate: string; deliveryDate: string | null }>
): Promise<PolicyInvestigationFinding> {
  const fork = sessions.forkSession(parentSessionId, `policy investigation: ${region} / ${scenarios.map((s) => s.sku).join(", ")}`);
  const forkMcp: MercuryMcpConnection = await connectMercuryMcp({ traceId: fork.traceId, readOnlySession: true });

  const inspected: PolicyInvestigationFinding["scenariosInspected"] = [];
  const citations: PolicyCitation[] = [];
  let conflictsFound = false;

  try {
    for (const scenario of scenarios) {
      const result = await evaluatePolicy({
        region,
        sku: scenario.sku,
        issueType: "return",
        deliveryDate: scenario.deliveryDate,
        asOfDate: scenario.asOfDate,
        traceId: fork.traceId,
      });
      if (result.success) {
        inspected.push({ sku: scenario.sku, asOfDate: scenario.asOfDate, decision: result.decision, confidence: result.confidence });
        citations.push(...result.citations);
        if (result.conflicts.length > 0) conflictsFound = true;
      }
    }
  } finally {
    await forkMcp.close();
  }

  sessions.saveTranscript(fork.sessionId, [], "completed");

  return {
    forkSessionId: fork.sessionId,
    scenariosInspected: inspected,
    conflictsFound,
    citations,
    summary: conflictsFound
      ? `Conflicting policy determinations found across ${inspected.length} scenario(s) for region ${region}.`
      : `No conflicts found across ${inspected.length} scenario(s) for region ${region}.`,
  };
}

/**
 * Explicitly copies a fork's policy citations into the parent's CaseContext.
 * This is the "controlled merge": findings are never applied automatically —
 * the caller (coordinator or a human reviewer) decides to accept them.
 */
export function mergePolicyFindingIntoParent(finding: PolicyInvestigationFinding, parentContext: CaseContext): void {
  for (const citation of finding.citations) {
    parentContext.seenPolicyCitations.set(citation.policyId, citation);
    parentContext.provenance.push(citation.provenance);
  }
}
