/**
 * Governance CI runner (spec sections 31-37). Deterministic checks
 * (src/governance/deterministicChecks.ts) always run first and gate the
 * result on their own; a model-assisted semantic pass runs ONLY if the
 * `claude` CLI is actually present on PATH (checked at runtime via `which`/
 * `where`, never assumed) and is treated as strictly additive — its absence
 * or failure never turns a `fail` into a `pass`, and malformed model output
 * is discarded with a note rather than silently accepted (spec section 37:
 * "malformed review output must never silently pass a change").
 *
 * IMPORTANT: this sandbox does not have the `claude` CLI installed
 * (`command not found` when probed during development), so the model-assisted
 * path below has never actually executed end-to-end here — only the
 * deterministic path has been run and verified. The exact flags used
 * (`-p`, `--output-format json`) are taken from the spec's own description
 * of "capabilities comparable to" these flags; they are NOT independently
 * verified against `claude --help` in this environment. See
 * docs/ci-governance.md for this limitation, spelled out per spec section 32
 * ("do not claim unsupported functionality").
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runAllDeterministicChecks } from "./deterministicChecks.js";
import { parseCiReview, DEFAULT_BLOCKING_SEVERITIES, type CiReview, type CiFinding } from "../domain/schemas/ciReview.js";

const execFileAsync = promisify(execFile);
const PRIOR_FINDINGS_PATH = path.join(process.cwd(), ".governance", "prior-findings.json");

export async function isClaudeCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", ["claude"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort model-assisted pass. Returns `null` (not an empty array) when
 * unavailable or when it fails, so the caller can distinguish "ran and found
 * nothing" from "did not run" in reviewMetadata/notes.
 */
async function runModelAssistedReview(prompt: string): Promise<{ findings: CiFinding[] } | null> {
  const available = await isClaudeCliAvailable();
  if (!available) return null;
  try {
    const { stdout } = await execFileAsync("claude", ["-p", prompt, "--output-format", "json"], { timeout: 120_000 });
    const parsedOuter = JSON.parse(stdout) as unknown;
    // Claude Code's -p --output-format json wraps the model's own text reply;
    // we expect that reply to itself be a JSON CiReview object per our prompt.
    const innerText = typeof parsedOuter === "object" && parsedOuter !== null && "result" in parsedOuter
      ? String((parsedOuter as { result: unknown }).result)
      : stdout;
    const inner = JSON.parse(innerText) as unknown;
    const validated = parseCiReview(inner);
    if (!validated.ok) return null; // malformed output -> discarded, never trusted
    return { findings: validated.value.findings };
  } catch {
    return null;
  }
}

function decideStatus(findings: CiFinding[]): CiReview["status"] {
  const blocking = findings.filter((f) => (DEFAULT_BLOCKING_SEVERITIES as readonly string[]).includes(f.severity));
  if (blocking.length > 0) return "fail";
  if (findings.length > 0) return "pass_with_notes";
  return "pass";
}

export interface RunGovernanceReviewOptions {
  reviewType: CiReview["reviewType"];
  reviewedFiles: string[];
  commit?: string | null;
  baseCommit?: string | null;
  modelPrompt?: string;
}

export interface GovernanceReviewOutcome {
  review: CiReview;
  modelAssisted: "ran" | "skipped_unavailable" | "skipped_malformed_or_failed";
}

export async function runGovernanceReview(options: RunGovernanceReviewOptions): Promise<GovernanceReviewOutcome> {
  const deterministic = runAllDeterministicChecks();

  let modelAssisted: GovernanceReviewOutcome["modelAssisted"] = "skipped_unavailable";
  let modelFindings: CiFinding[] = [];
  if (options.modelPrompt) {
    const available = await isClaudeCliAvailable();
    if (available) {
      const result = await runModelAssistedReview(options.modelPrompt);
      if (result) {
        modelAssisted = "ran";
        modelFindings = result.findings;
      } else {
        modelAssisted = "skipped_malformed_or_failed";
      }
    }
  }

  const allFindings = [...deterministic, ...modelFindings];
  const review: CiReview = {
    schemaVersion: "1.0",
    status: decideStatus(allFindings),
    reviewType: options.reviewType,
    findings: allFindings,
    suppressedFindings: [],
    reviewedFiles: options.reviewedFiles,
    reviewMetadata: {
      commit: options.commit ?? null,
      baseCommit: options.baseCommit ?? null,
      generatedAt: new Date().toISOString(),
    },
  };
  return { review, modelAssisted };
}

export interface FindingComparison {
  fresh: CiFinding[];
  stillActive: CiFinding[];
  fixed: CiFinding[];
}

export function compareAgainstPrior(current: CiFinding[], prior: CiFinding[]): FindingComparison {
  const priorByFingerprint = new Map(prior.map((f) => [f.fingerprint, f]));
  const currentByFingerprint = new Map(current.map((f) => [f.fingerprint, f]));
  return {
    fresh: current.filter((f) => !priorByFingerprint.has(f.fingerprint)),
    stillActive: current.filter((f) => priorByFingerprint.has(f.fingerprint)),
    fixed: prior.filter((f) => !currentByFingerprint.has(f.fingerprint)),
  };
}

export async function loadPriorFindings(): Promise<CiFinding[]> {
  try {
    const raw = await readFile(PRIOR_FINDINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CiFinding[]) : [];
  } catch {
    return [];
  }
}

export async function savePriorFindings(findings: CiFinding[]): Promise<void> {
  await mkdir(path.dirname(PRIOR_FINDINGS_PATH), { recursive: true });
  await writeFile(PRIOR_FINDINGS_PATH, JSON.stringify(findings, null, 2), "utf-8");
}

async function main(): Promise<void> {
  const { review, modelAssisted } = await runGovernanceReview({
    reviewType: "integrated",
    reviewedFiles: ["policies/", "src/domain/roles.ts", "src/mcp/toolDefinitions.ts"],
  });
  const prior = await loadPriorFindings();
  const comparison = compareAgainstPrior(review.findings, prior);
  await savePriorFindings(review.findings);

  console.log(JSON.stringify({ review, modelAssisted, comparison: {
    freshCount: comparison.fresh.length,
    stillActiveCount: comparison.stillActive.length,
    fixedCount: comparison.fixed.length,
    fixedThenReturned: comparison.fresh.filter((f) => prior.some((p) => p.fingerprint === f.fingerprint)),
  } }, null, 2));

  if (review.status === "fail") process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("ciReview.ts");
if (isMain) {
  main().catch((error) => {
    console.error("Governance review failed:", error);
    process.exitCode = 1;
  });
}
