/**
 * Deterministic governance checks (spec section 31) — run BEFORE any
 * model-assisted review, and the only checks guaranteed to run at all in a
 * restricted CI context (no model access, untrusted PR, etc.). Operates on
 * the actual runtime policy catalog and permission tables rather than
 * re-parsing markdown, since spec-required "broken policy reference" /
 * "invalid effective-date ordering" bugs are bugs in what the system would
 * actually load, not just in the source markdown's front-matter.
 */

import { policyCatalog } from "../mock-backends/data.js";
import { ADVISOR_ALLOWED_TOOLS, HUMAN_EXECUTION_ONLY_TOOLS } from "../domain/roles.js";
import { SUPPORTED_REGIONS } from "../domain/config.js";
import { listApprovals } from "../approvals/store.js";
import { buildFingerprint, type CiFinding } from "../domain/schemas/ciReview.js";

const HASH_RE = /^[a-f0-9]{64}$/;

export function checkPolicyCatalog(): CiFinding[] {
  const findings: CiFinding[] = [];
  const seenKeys = new Set<string>();

  for (const doc of policyCatalog) {
    const key = `${doc.policyId}@${doc.version}`;
    if (seenKeys.has(key)) {
      findings.push(makeFinding({
        severity: "blocker",
        category: "policy-duplicate-identifier",
        path: doc.sourceFile,
        summary: `Duplicate policy identifier+version "${key}".`,
        evidence: key,
        ruleReference: "spec-section-31-duplicate-identifier-detection",
        suggestedFix: `Ensure each (policyId, version) pair in the catalog is unique — bump the version or remove the duplicate.`,
      }));
    }
    seenKeys.add(key);

    if (!doc.effectiveDate) {
      findings.push(makeFinding({
        severity: "blocker",
        category: "policy-missing-effective-date",
        path: doc.sourceFile,
        summary: `Policy "${doc.policyId}" is missing an effectiveDate.`,
        evidence: JSON.stringify({ policyId: doc.policyId, version: doc.version }),
        ruleReference: "spec-section-31-missing-effective-dates",
        suggestedFix: "Add an explicit effectiveDate (YYYY-MM-DD) to the policy document.",
      }));
    } else if (doc.expirationDate && doc.expirationDate < doc.effectiveDate) {
      findings.push(makeFinding({
        severity: "blocker",
        category: "policy-invalid-date-ordering",
        path: doc.sourceFile,
        summary: `Policy "${doc.policyId}" expirationDate (${doc.expirationDate}) precedes its effectiveDate (${doc.effectiveDate}).`,
        evidence: `effectiveDate=${doc.effectiveDate} expirationDate=${doc.expirationDate}`,
        ruleReference: "spec-section-31-invalid-effective-date-ordering",
        suggestedFix: "Correct effectiveDate/expirationDate so the policy has a non-empty valid interval.",
      }));
    }

    if (doc.region !== "ALL" && !(SUPPORTED_REGIONS as readonly string[]).includes(doc.region)) {
      findings.push(makeFinding({
        severity: "high",
        category: "policy-invalid-region",
        path: doc.sourceFile,
        summary: `Policy "${doc.policyId}" references unsupported region "${doc.region}".`,
        evidence: doc.region,
        ruleReference: "spec-section-31-invalid-currency-region-identifiers",
        suggestedFix: `Use one of: ${SUPPORTED_REGIONS.join(", ")}, or "ALL".`,
      }));
    }

    for (const supersededId of doc.supersedes) {
      if (!policyCatalog.some((d) => d.policyId === supersededId)) {
        findings.push(makeFinding({
          severity: "high",
          category: "policy-broken-reference",
          path: doc.sourceFile,
          summary: `Policy "${doc.policyId}" claims to supersede unknown policyId "${supersededId}".`,
          evidence: supersededId,
          ruleReference: "spec-section-31-broken-policy-references",
          suggestedFix: `Remove "${supersededId}" from supersedes, or add the missing policy document.`,
        }));
      }
    }

    if (!doc.sourceFile) {
      findings.push(makeFinding({
        severity: "blocker",
        category: "policy-missing-provenance",
        path: "src/mock-backends/data.ts",
        summary: `Policy "${doc.policyId}" has no sourceFile provenance reference.`,
        evidence: doc.policyId,
        ruleReference: "spec-section-31-missing-provenance",
        suggestedFix: "Every policy document must reference the source markdown file it was synced from.",
      }));
    }
  }

  return findings;
}

export function checkPermissionConfiguration(): CiFinding[] {
  const findings: CiFinding[] = [];
  for (const tool of HUMAN_EXECUTION_ONLY_TOOLS) {
    if (ADVISOR_ALLOWED_TOOLS.has(tool)) {
      findings.push(makeFinding({
        severity: "blocker",
        category: "permission-configuration",
        path: "src/domain/roles.ts",
        summary: `Tool "${tool}" appears in BOTH ADVISOR_ALLOWED_TOOLS and HUMAN_EXECUTION_ONLY_TOOLS.`,
        evidence: tool,
        ruleReference: "spec-section-31-permission-configuration-validation",
        suggestedFix: `Remove "${tool}" from ADVISOR_ALLOWED_TOOLS — it must be human-execution-only.`,
      }));
    }
  }
  return findings;
}

export function checkApprovalHashes(): CiFinding[] {
  const findings: CiFinding[] = [];
  for (const approval of listApprovals()) {
    if (!HASH_RE.test(approval.suggestionHash) || !HASH_RE.test(approval.actionHash)) {
      findings.push(makeFinding({
        severity: "blocker",
        category: "approval-hash-validation",
        path: "src/approvals/store.ts",
        summary: `Approval for suggestion "${approval.suggestionId}" / action "${approval.actionId}" has a malformed hash.`,
        evidence: `suggestionHash=${approval.suggestionHash} actionHash=${approval.actionHash}`,
        ruleReference: "spec-section-31-approval-hash-validation",
        suggestedFix: "Hashes must be exactly 64 lowercase hex characters (sha256 hex digest).",
      }));
    }
  }
  return findings;
}

export function runAllDeterministicChecks(): CiFinding[] {
  return [...checkPolicyCatalog(), ...checkPermissionConfiguration(), ...checkApprovalHashes()];
}

let findingSeq = 0;
function makeFinding(input: {
  severity: CiFinding["severity"];
  category: string;
  path: string;
  summary: string;
  evidence: string;
  ruleReference: string;
  suggestedFix: string;
}): CiFinding {
  findingSeq += 1;
  const fingerprint = buildFingerprint({ ruleReference: input.ruleReference, normalizedPath: input.path, category: input.category, normalizedEvidence: input.evidence });
  return {
    findingId: `finding_${fingerprint.slice(0, 12)}`,
    severity: input.severity,
    category: input.category,
    path: input.path,
    lineStart: 0,
    lineEnd: 0,
    summary: input.summary,
    evidence: input.evidence,
    ruleReference: input.ruleReference,
    suggestedFix: input.suggestedFix,
    confidence: 1,
    fingerprint,
  };
}
