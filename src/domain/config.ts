/**
 * Centralized, environment-driven configuration for every business threshold
 * used by programmatic enforcement (see src/agent/hooks.ts). Nothing in the
 * agent, subagents, or tools should hard-code a dollar amount or iteration
 * limit — they must read it from here so operators can retune behavior without
 * touching code, and so tests can assert against named constants instead of
 * magic numbers.
 */

import { money, type Money } from "./money.js";

function envDecimal(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim().length > 0 ? raw.trim() : fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const SUPPORTED_REGIONS = ["US", "EU", "UK", "CA", "AU"] as const;
export type Region = (typeof SUPPORTED_REGIONS)[number];

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export interface MercuryConfig {
  /**
   * Advisory ceiling used only to flag a proposed refund as high-risk for
   * the precision review pass (spec section 6/14, MERCURY_REFUND_LIMIT_USD).
   * Track 2 has no autonomous execution path, so this never authorizes a
   * refund by itself — it only feeds risk classification and the human
   * approval gate's "requires 2 approvals" tier (src/approvals/decide.ts).
   */
  refundLimit: (currency: string) => Money;
  /** Per-issue confidence below this triggers a "low confidence" precision-review flag (section 14). */
  advisorConfidenceThreshold: number;
  maxAgentSteps: number;
  maxRetries: number;
  maxOutputRetries: number;
  enableLiveApiTests: boolean;
  model: string;
  env: string;
  dbPath: string;
  logLevel: string;
}

const refundLimitDecimal = envDecimal("MERCURY_REFUND_LIMIT_USD", "150.00");

export const config: MercuryConfig = {
  refundLimit: (currency: string) => money(refundLimitDecimal, currency),
  advisorConfidenceThreshold: (() => {
    const raw = process.env.MERCURY_ADVISOR_CONFIDENCE_THRESHOLD;
    const parsed = raw ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.75;
  })(),
  maxAgentSteps: envInt("MERCURY_MAX_AGENT_STEPS", 12),
  maxRetries: envInt("MERCURY_MAX_RETRIES", 2),
  maxOutputRetries: envInt("MERCURY_MAX_OUTPUT_RETRIES", 2),
  enableLiveApiTests: process.env.MERCURY_ENABLE_LIVE_API_TESTS === "1",
  model: process.env.MERCURY_MODEL ?? "claude-sonnet-4-5",
  env: process.env.MERCURY_ENV ?? "development",
  dbPath: process.env.MERCURY_DB_PATH ?? ":memory:",
  logLevel: process.env.MERCURY_LOG_LEVEL ?? "info",
};

export function isSupportedRegion(region: string): region is Region {
  return (SUPPORTED_REGIONS as readonly string[]).includes(region);
}

export function isSupportedCurrency(currency: string): currency is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency);
}
