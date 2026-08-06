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
  /** Refunds at/below this amount MAY be processed autonomously (subject to identity + policy confidence). */
  autonomousRefundLimit: (currency: string) => Money;
  /** Refunds at/above this amount ALWAYS require human escalation, no exceptions. */
  mandatoryEscalationLimit: (currency: string) => Money;
  maxLoopIterations: number;
  maxToolRetries: number;
  maxOutputRetries: number;
  enableLiveApiTests: boolean;
  model: string;
}

const autonomousRefundLimitDecimal = envDecimal("MERCURY_AUTONOMOUS_REFUND_LIMIT", "150.00");
const mandatoryEscalationLimitDecimal = envDecimal("MERCURY_MANDATORY_ESCALATION_LIMIT", "500.00");

export const config: MercuryConfig = {
  autonomousRefundLimit: (currency: string) => money(autonomousRefundLimitDecimal, currency),
  mandatoryEscalationLimit: (currency: string) => money(mandatoryEscalationLimitDecimal, currency),
  maxLoopIterations: envInt("MERCURY_MAX_LOOP_ITERATIONS", 12),
  maxToolRetries: envInt("MERCURY_MAX_TOOL_RETRIES", 2),
  maxOutputRetries: envInt("MERCURY_MAX_OUTPUT_RETRIES", 2),
  enableLiveApiTests: process.env.MERCURY_ENABLE_LIVE_API_TESTS === "1",
  model: process.env.MERCURY_MODEL ?? "claude-sonnet-4-5",
};

export function isSupportedRegion(region: string): region is Region {
  return (SUPPORTED_REGIONS as readonly string[]).includes(region);
}

export function isSupportedCurrency(currency: string): currency is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency);
}
