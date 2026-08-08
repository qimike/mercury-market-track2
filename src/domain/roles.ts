/**
 * Role and permission model (spec section 10). A role is never a value the
 * model can set via tool input — it is fixed per MCP connection at the
 * moment the connection is created (see src/mcp/server.ts's
 * `MercuryServerOptions.callerRole` and src/agent/mcpClient.ts /
 * src/approvals/execute.ts, the only two call sites that open a connection).
 * This is what makes "the advisor cannot execute a side effect" a structural
 * fact rather than a prompt-level convention: the advisor's connection is
 * permanently bound to `advisor_agent`, and only a separate, short-lived
 * connection opened by the approvals execution path is ever bound to
 * `human_support_agent`.
 */

export const ROLES = [
  "advisor_agent",
  "human_support_agent",
  "policy_reviewer",
  "ci_governance",
  "system_administrator",
] as const;

export type Role = (typeof ROLES)[number];

/** Tools the advisor may call directly. Everything else on the MCP server is refused for this role. */
export const ADVISOR_ALLOWED_TOOLS = new Set([
  "get_customer",
  "verify_customer_identity",
  "lookup_order",
  "get_payment_history",
  "evaluate_policy",
  "get_case_history",
  "record_case_event",
  "record_case_facts",
  "escalate_to_human",
  "submit_identity_finding",
  "submit_order_finding",
  "submit_policy_finding",
  "submit_resolution_finding",
  "submit_suggestion_packet",
]);

/**
 * Tools that move money or otherwise cause an externally visible,
 * customer-affecting side effect. These are refused unconditionally for
 * every role except `human_support_agent`, and even then only when the tool
 * input carries a valid, hash-matched, unexpired approval (see
 * src/mcp/authorization.ts and src/approvals/).
 */
export const HUMAN_EXECUTION_ONLY_TOOLS = new Set(["process_refund", "create_return"]);

export function isToolAllowedForRole(toolName: string, role: Role): boolean {
  if (HUMAN_EXECUTION_ONLY_TOOLS.has(toolName)) {
    return role === "human_support_agent";
  }
  if (role === "advisor_agent") {
    return ADVISOR_ALLOWED_TOOLS.has(toolName);
  }
  // human_support_agent, policy_reviewer, ci_governance, system_administrator
  // may also use every read-only/advisor tool (e.g. a human reviewing the
  // same case history the advisor saw) in addition to their own tools.
  return ADVISOR_ALLOWED_TOOLS.has(toolName);
}
