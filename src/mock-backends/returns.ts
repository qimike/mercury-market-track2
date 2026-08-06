/**
 * Mock returns authorization, backing `create_return`. Side-effecting: creates
 * a return record against a delivered order. Does not move money — refund
 * execution is a separate, more tightly controlled step (`process_refund`).
 */

import { orders } from "./data.js";
import { fail, ok, type ToolResult } from "../domain/errors.js";

export interface ReturnLineItem {
  sku: string;
  quantity: number;
}

export interface ReturnRecord {
  returnId: string;
  orderId: string;
  customerId: string;
  lineItems: ReturnLineItem[];
  reason: string;
  status: "authorized";
  createdAt: string;
}

const returns: ReturnRecord[] = [];
let returnSeq = 5000;

export async function createReturn(
  orderId: string,
  customerId: string,
  lineItems: ReturnLineItem[],
  reason: string
): Promise<ToolResult<{ returnRecord: ReturnRecord }>> {
  const order = orders[orderId];
  if (!order) {
    return fail("NOT_FOUND", "ORDER_NOT_FOUND", `No order found with id "${orderId}".`, false);
  }
  if (order.customerId !== customerId) {
    return fail(
      "ACCESS",
      "ORDER_OWNERSHIP_MISMATCH",
      `Order "${orderId}" does not belong to customer "${customerId}".`,
      false
    );
  }
  if (order.status !== "delivered") {
    return fail(
      "VALIDATION",
      "ORDER_NOT_DELIVERED",
      `Order "${orderId}" has status "${order.status}"; only delivered orders can be returned.`,
      false
    );
  }
  if (lineItems.length === 0) {
    return fail("VALIDATION", "NO_LINE_ITEMS", "At least one line item is required to create a return.", false);
  }
  for (const requested of lineItems) {
    const match = order.lineItems.find((li) => li.sku === requested.sku);
    if (!match) {
      return fail(
        "VALIDATION",
        "LINE_ITEM_NOT_ON_ORDER",
        `SKU "${requested.sku}" is not part of order "${orderId}".`,
        false
      );
    }
    if (requested.quantity > match.quantity) {
      return fail(
        "VALIDATION",
        "RETURN_QUANTITY_EXCEEDS_ORDERED",
        `Requested return quantity ${requested.quantity} for SKU "${requested.sku}" exceeds ordered quantity ${match.quantity}.`,
        false
      );
    }
  }

  returnSeq += 1;
  const returnRecord: ReturnRecord = {
    returnId: `ret_${returnSeq}`,
    orderId,
    customerId,
    lineItems,
    reason,
    status: "authorized",
    createdAt: new Date().toISOString(),
  };
  returns.push(returnRecord);
  return ok({ returnRecord });
}

export function _resetReturnsMockState(): void {
  returns.length = 0;
  returnSeq = 5000;
}
