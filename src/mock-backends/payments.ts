/**
 * Mock Payments system. Backs `get_payment_history` (read) and `process_refund`
 * (side-effecting). This module is the source of truth for idempotency,
 * remaining-refundable-balance, and currency-match enforcement — the agent
 * loop's hooks (src/agent/hooks.ts) add a pre-flight check as defense in
 * depth, but this mock is what actually decides and never issues a duplicate
 * refund for a replayed idempotency key.
 */

import { orders, paymentTransactions, _resetSeedDataMockState, type PaymentTransaction } from "./data.js";
import { fail, ok, type ToolResult } from "../domain/errors.js";
import { formatMoney, money, parseMoney, subtractMoney, sumMoney, compareMoney } from "../domain/money.js";

export interface RefundSummary {
  transactionId: string;
  amount: string;
  currency: string;
  createdAt: string;
}

export interface PaymentHistory {
  refunds: RefundSummary[];
  remainingRefundableAmount: string;
  currency: string;
}

export interface ProcessRefundOutput {
  transactionId: string;
  amount: string;
  currency: string;
  replayed: boolean;
  createdAt: string;
}

/** Simulated gateway flakiness: number of TRANSIENT failures to emit before an order's refund succeeds. */
const flakyGateway: Record<string, number> = {
  ord_1007: 1,
  ord_1008: Number.POSITIVE_INFINITY,
};

const idempotencyStore = new Map<string, ToolResult<ProcessRefundOutput>>();

function remainingRefundable(orderId: string): { amount: ReturnType<typeof money>; refunds: PaymentTransaction[] } {
  const order = orders[orderId];
  const refunds = paymentTransactions.filter((t) => t.orderId === orderId && t.type === "refund");
  const refunded = sumMoney(
    refunds.map((r) => r.amount),
    order?.currency ?? "USD"
  );
  const remaining = order ? subtractMoney(order.amountPaid, refunded) : refunded;
  return { amount: remaining, refunds };
}

export async function getPaymentHistory(orderId: string): Promise<ToolResult<PaymentHistory>> {
  const order = orders[orderId];
  if (!order) {
    return fail("NOT_FOUND", "ORDER_NOT_FOUND", `No order found with id "${orderId}".`, false);
  }
  const { amount, refunds } = remainingRefundable(orderId);
  return ok({
    refunds: refunds.map((r) => ({
      transactionId: r.transactionId,
      amount: formatMoney(r.amount),
      currency: r.amount.currency,
      createdAt: r.createdAt,
    })),
    remainingRefundableAmount: formatMoney(amount),
    currency: order.currency,
  });
}

export interface ProcessRefundInput {
  orderId: string;
  customerId: string;
  amount: string;
  currency: string;
  reason: string;
  idempotencyKey: string;
}

let transactionSeq = 9100;

/** Overridable for deterministic tests; defaults to the real clock in the running app. */
let clock: () => string = () => new Date().toISOString();
export function _setPaymentsClock(fn: () => string): void {
  clock = fn;
}

export async function processRefund(
  input: ProcessRefundInput
): Promise<ToolResult<ProcessRefundOutput>> {
  if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
    return fail(
      "VALIDATION",
      "IDEMPOTENCY_KEY_REQUIRED",
      "process_refund requires a non-empty idempotencyKey to guarantee at-most-once execution.",
      false
    );
  }

  const cached = idempotencyStore.get(input.idempotencyKey);
  if (cached) {
    if (!cached.success) return cached;
    return ok({ ...cached, replayed: true });
  }

  const order = orders[input.orderId];
  if (!order) {
    return fail("NOT_FOUND", "ORDER_NOT_FOUND", `No order found with id "${input.orderId}".`, false);
  }
  if (order.customerId !== input.customerId) {
    return fail(
      "ACCESS",
      "ORDER_OWNERSHIP_MISMATCH",
      `Order "${input.orderId}" does not belong to customer "${input.customerId}".`,
      false
    );
  }

  const parsedAmount = parseMoney(input.amount, input.currency);
  if (!parsedAmount.ok) {
    return { success: false, error: parsedAmount.error };
  }

  if (parsedAmount.value.currency !== order.currency) {
    return fail(
      "VALIDATION",
      "CURRENCY_MISMATCH",
      `Refund currency "${parsedAmount.value.currency}" does not match order currency "${order.currency}".`,
      false
    );
  }

  const { amount: remaining } = remainingRefundable(input.orderId);
  if (compareMoney(parsedAmount.value, remaining) > 0) {
    return fail(
      "CONFLICT",
      "REFUND_EXCEEDS_BALANCE",
      `Requested refund ${formatMoney(parsedAmount.value)} ${parsedAmount.value.currency} exceeds the ` +
        `remaining refundable balance of ${formatMoney(remaining)} ${remaining.currency} for order "${input.orderId}".`,
      false,
      { remainingRefundableAmount: formatMoney(remaining) }
    );
  }

  const failuresRemaining = flakyGateway[input.orderId] ?? 0;
  if (failuresRemaining > 0) {
    if (Number.isFinite(failuresRemaining)) {
      flakyGateway[input.orderId] = failuresRemaining - 1;
    }
    const failure: ToolResult<ProcessRefundOutput> = fail(
      "DEPENDENCY",
      "PAYMENT_GATEWAY_TIMEOUT",
      "The payments gateway timed out processing the refund. This is transient and safe to retry.",
      true
    );
    // Transient failures are NOT cached under the idempotency key — a retry with
    // the same key must be allowed to actually reach the gateway again.
    return failure;
  }

  transactionSeq += 1;
  const transactionId = `txn_${transactionSeq}`;
  const createdAt = clock();
  const record: PaymentTransaction = {
    transactionId,
    orderId: input.orderId,
    customerId: input.customerId,
    type: "refund",
    amount: parsedAmount.value,
    idempotencyKey: input.idempotencyKey,
    createdAt,
  };
  paymentTransactions.push(record);

  const result = ok<ProcessRefundOutput>({
    transactionId,
    amount: formatMoney(parsedAmount.value),
    currency: parsedAmount.value.currency,
    replayed: false,
    createdAt,
  });
  idempotencyStore.set(input.idempotencyKey, result);
  return result;
}

export function _resetPaymentsMockState(): void {
  idempotencyStore.clear();
  flakyGateway.ord_1007 = 1;
  flakyGateway.ord_1008 = Number.POSITIVE_INFINITY;
  transactionSeq = 9100;
  clock = () => new Date().toISOString();
  // Also restores paymentTransactions/customers back to their seeded values —
  // see the comment on _resetSeedDataMockState in data.ts for why this is
  // required, not merely this module's own idempotency/flaky-gateway state.
  _resetSeedDataMockState();
}
