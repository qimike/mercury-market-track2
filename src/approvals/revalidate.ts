/**
 * Immediate pre-execution revalidation (spec sections 8/20: "immediately
 * before execution, rerun all applicable authorization, policy, arithmetic,
 * threshold, currency, ownership, and idempotency validation"). Deliberately
 * checked against FRESH data fetched at execution time
 * (src/approvals/execute.ts fetches a new get_payment_history result right
 * before calling this) — never against the suggestion packet's possibly
 * stale figures, since time may have passed between proposal and approval.
 */

import { parseMoney, compareMoney } from "../domain/money.js";

export type RevalidationResult = { ok: true } | { ok: false; error: string };

export interface FreshPaymentSnapshot {
  success: boolean;
  remainingRefundableAmount?: string;
  currency?: string;
}

export function revalidateRefundAmount(
  proposed: { amount: string; currency: string },
  fresh: FreshPaymentSnapshot
): RevalidationResult {
  if (!fresh.success) {
    return { ok: false, error: "Could not re-fetch payment history immediately before execution; refusing to execute against stale data." };
  }
  const parsedAmount = parseMoney(proposed.amount, proposed.currency);
  if (!parsedAmount.ok) {
    return { ok: false, error: parsedAmount.error.message };
  }
  if (parsedAmount.value.minorUnits < 0) {
    return { ok: false, error: "Proposed refund amount must be non-negative." };
  }
  if (fresh.currency && parsedAmount.value.currency !== fresh.currency) {
    return { ok: false, error: `Proposed currency "${parsedAmount.value.currency}" does not match the order's currency "${fresh.currency}" as of execution time.` };
  }
  if (fresh.remainingRefundableAmount !== undefined) {
    const known = parseMoney(fresh.remainingRefundableAmount, fresh.currency ?? parsedAmount.value.currency);
    if (known.ok && compareMoney(parsedAmount.value, known.value) > 0) {
      return {
        ok: false,
        error: `Proposed amount ${proposed.amount} ${proposed.currency} exceeds the remaining refundable balance ` +
          `(${fresh.remainingRefundableAmount} ${fresh.currency}) as of execution time — the balance may have ` +
          "changed since the suggestion was approved.",
      };
    }
  }
  return { ok: true };
}
