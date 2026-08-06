/**
 * Mock CRM system. Backs the `get_customer` MCP tool. Read-only.
 */

import { customers } from "./data.js";
import { fail, ok, type ToolResult } from "../domain/errors.js";

export interface CustomerProfile {
  customer: {
    customerId: string;
    name: string;
    maskedEmail: string;
    region: string;
    defaultCurrency: string;
    identityStatus: "unverified" | "verified" | "locked";
    accountFlags: string[];
  };
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "***";
  const visible = user.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(user.length - 1, 1))}@${domain}`;
}

export async function getCustomer(customerId: string): Promise<ToolResult<CustomerProfile>> {
  const record = customers[customerId];
  if (!record) {
    return fail(
      "NOT_FOUND",
      "CUSTOMER_NOT_FOUND",
      `No customer found with id "${customerId}".`,
      false
    );
  }
  return ok({
    customer: {
      customerId: record.customerId,
      name: record.name,
      maskedEmail: maskEmail(record.email),
      region: record.region,
      defaultCurrency: record.defaultCurrency,
      identityStatus: record.identityStatus,
      accountFlags: record.accountFlags,
    },
  });
}
