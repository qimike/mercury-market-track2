/**
 * Decimal-safe money handling.
 *
 * Money is never represented as a JS `number` internally — amounts are parsed
 * into integer minor units (e.g. cents) so arithmetic never hits floating point
 * rounding error. All public boundaries (tool inputs/outputs, schemas sent to
 * Claude) use decimal strings like "42.50", never floats.
 */

import { ToolError, err } from "./errors.js";

export interface Money {
  readonly currency: string;
  /** Integer amount in the currency's minor unit (cents for USD, etc). */
  readonly minorUnits: number;
}

const MINOR_UNIT_EXPONENT: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
};

function exponentFor(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency] ?? 2;
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function parseMoney(
  amount: string,
  currency: string
): { ok: true; value: Money } | { ok: false; error: ToolError } {
  const cur = currency.toUpperCase();
  if (!DECIMAL_RE.test(amount.trim())) {
    return {
      ok: false,
      error: err(
        "VALIDATION",
        "INVALID_MONEY_FORMAT",
        `Amount "${amount}" is not a valid decimal string.`,
        false
      ),
    };
  }
  const exp = exponentFor(cur);
  const [wholeRaw, fracRaw = ""] = amount.trim().split(".");
  const whole = wholeRaw ?? "0";
  const negative = whole.startsWith("-");
  const wholeDigits = negative ? whole.slice(1) : whole;
  const frac = (fracRaw + "0".repeat(exp)).slice(0, exp);
  if (fracRaw.length > exp) {
    return {
      ok: false,
      error: err(
        "VALIDATION",
        "MONEY_PRECISION_EXCEEDED",
        `Amount "${amount}" has more precision than ${cur} supports (${exp} decimal places).`,
        false
      ),
    };
  }
  const minorUnits =
    (negative ? -1 : 1) * (Number(wholeDigits) * 10 ** exp + Number(frac || "0"));
  return { ok: true, value: { currency: cur, minorUnits } };
}

/** Throwing variant for call sites that have already validated the input (e.g. seed data, tests). */
export function money(amount: string, currency: string): Money {
  const result = parseMoney(amount, currency);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function formatMoney(m: Money): string {
  const exp = exponentFor(m.currency);
  const negative = m.minorUnits < 0;
  const abs = Math.abs(m.minorUnits);
  const divisor = 10 ** exp;
  const wholePart = Math.floor(abs / divisor);
  const fracPart = abs % divisor;
  const fracStr = exp > 0 ? "." + String(fracPart).padStart(exp, "0") : "";
  return `${negative ? "-" : ""}${wholePart}${fracStr}`;
}

export function sameCurrency(a: Money, b: Money): boolean {
  return a.currency === b.currency;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { currency: a.currency, minorUnits: a.minorUnits + b.minorUnits };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { currency: a.currency, minorUnits: a.minorUnits - b.minorUnits };
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minorUnits < b.minorUnits) return -1;
  if (a.minorUnits > b.minorUnits) return 1;
  return 0;
}

export function isZeroOrNegative(m: Money): boolean {
  return m.minorUnits <= 0;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(
      `Currency mismatch: cannot combine ${a.currency} and ${b.currency} amounts.`
    );
  }
}

export function sumMoney(items: Money[], currency: string): Money {
  return items.reduce(
    (acc, m) => addMoney(acc, m),
    { currency, minorUnits: 0 } as Money
  );
}
