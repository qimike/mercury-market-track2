/**
 * Mock Order Management System (OMS). Backs `lookup_order`. Read-only.
 */

import { orders, type OrderRecord } from "./data.js";
import { fail, ok, type ToolResult } from "../domain/errors.js";
import { formatMoney } from "../domain/money.js";

export interface OrderFacts {
  order: {
    orderId: string;
    customerId: string;
    region: string;
    currency: string;
    status: OrderRecord["status"];
    orderDate: string;
    deliveryDate: string | null;
    lineItems: Array<{
      sku: string;
      description: string;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
    }>;
    amountPaid: string;
  };
}

export async function lookupOrder(
  orderId: string,
  requestingCustomerId: string
): Promise<ToolResult<OrderFacts>> {
  const record = orders[orderId];
  if (!record) {
    return fail("NOT_FOUND", "ORDER_NOT_FOUND", `No order found with id "${orderId}".`, false);
  }
  if (record.customerId !== requestingCustomerId) {
    return fail(
      "ACCESS",
      "ORDER_OWNERSHIP_MISMATCH",
      `Order "${orderId}" does not belong to customer "${requestingCustomerId}".`,
      false
    );
  }
  return ok({
    order: {
      orderId: record.orderId,
      customerId: record.customerId,
      region: record.region,
      currency: record.currency,
      status: record.status,
      orderDate: record.orderDate,
      deliveryDate: record.deliveryDate,
      lineItems: record.lineItems.map((li) => ({
        sku: li.sku,
        description: li.description,
        quantity: li.quantity,
        unitPrice: formatMoney(li.unitPrice),
        lineTotal: formatMoney({ currency: li.unitPrice.currency, minorUnits: li.unitPrice.minorUnits * li.quantity }),
      })),
      amountPaid: formatMoney(record.amountPaid),
    },
  });
}
