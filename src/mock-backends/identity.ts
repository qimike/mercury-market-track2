/**
 * Mock identity/verification service. Backs `verify_customer_identity`.
 * This is the ONLY code path allowed to move a customer from "unverified" to
 * "verified" — the agent loop's identity-enforcement hook (src/agent/hooks.ts)
 * treats `identityStatus` as ground truth and cannot be talked out of it.
 */

import { customers } from "./data.js";
import { fail, ok, type ToolResult } from "../domain/errors.js";

export interface VerificationOutcome {
  identityStatus: "unverified" | "verified" | "locked";
  verified: boolean;
}

export async function verifyCustomerIdentity(
  customerId: string,
  verificationValue: string
): Promise<ToolResult<VerificationOutcome>> {
  const record = customers[customerId];
  if (!record) {
    return fail("NOT_FOUND", "CUSTOMER_NOT_FOUND", `No customer found with id "${customerId}".`, false);
  }

  if (record.identityStatus === "locked") {
    return fail(
      "ACCESS",
      "ACCOUNT_LOCKED",
      `Account ${customerId} is locked pending fraud review and cannot self-verify. Escalate to human.`,
      false,
      { accountFlags: record.accountFlags }
    );
  }

  if (record.identityStatus === "verified") {
    return ok({ identityStatus: "verified", verified: true });
  }

  if (verificationValue.trim() === record.verificationAnswer) {
    record.identityStatus = "verified";
    return ok({ identityStatus: "verified", verified: true });
  }

  return ok({ identityStatus: "unverified", verified: false });
}
