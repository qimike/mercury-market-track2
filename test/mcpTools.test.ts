import { describe, it, expect, afterEach } from "vitest";
import { connectMercuryMcp, type MercuryMcpConnection } from "../src/agent/mcpClient.js";

describe("MCP server/client wiring", () => {
  let conn: MercuryMcpConnection | undefined;

  afterEach(async () => {
    await conn?.close();
    conn = undefined;
  });

  it("lists all 12 registered tools with non-empty descriptions and JSON schemas", async () => {
    conn = await connectMercuryMcp({ readOnlySession: false });
    const tools = await conn.listToolDefinitions();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "create_return",
        "escalate_to_human",
        "evaluate_policy",
        "get_case_history",
        "get_customer",
        "get_payment_history",
        "lookup_order",
        "process_refund",
        "record_case_event",
        "record_case_facts",
        "resolve_case",
        "submit_identity_finding",
        "submit_order_finding",
        "submit_policy_finding",
        "submit_refund_finding",
        "verify_customer_identity",
      ].sort()
    );
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.input_schema).toBeTruthy();
    }
  });

  it("calls get_customer successfully through the real MCP protocol", async () => {
    conn = await connectMercuryMcp({ readOnlySession: false });
    const result = await conn.callTool("get_customer", { customerId: "cust_001" });
    expect(result.success).toBe(true);
  });

  it("rejects malformed input at the MCP schema layer with a structured VALIDATION error", async () => {
    conn = await connectMercuryMcp({ readOnlySession: false });
    const result = await conn.callTool("get_customer", { customerId: 12345 as any });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errorCategory).toBe("VALIDATION");
      expect(result.error.isRetryable).toBe(false);
    }
  });

  it("returns NOT_FOUND for a nonexistent customer (not a thrown exception)", async () => {
    conn = await connectMercuryMcp({ readOnlySession: false });
    const result = await conn.callTool("get_customer", { customerId: "cust_nonexistent" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("CUSTOMER_NOT_FOUND");
  });

  it("blocks side-effecting tools in a read-only (forked) session", async () => {
    conn = await connectMercuryMcp({ readOnlySession: true });
    const result = await conn.callTool("verify_customer_identity", {
      customerId: "cust_001",
      verificationValue: "94107",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.errorCode).toBe("SIDE_EFFECT_IN_READ_ONLY_SESSION");
  });

  it("still allows read-only tools in a forked session", async () => {
    conn = await connectMercuryMcp({ readOnlySession: true });
    const result = await conn.callTool("evaluate_policy", {
      region: "US",
      sku: "HOME-MUG-01",
      issueType: "return",
      deliveryDate: "2026-07-24",
      asOfDate: "2026-08-05",
    });
    expect(result.success).toBe(true);
  });

  it("exposes the policy catalog and error taxonomy as readable resources", async () => {
    conn = await connectMercuryMcp({ readOnlySession: false });
    const catalog = await conn.readResource("mercury://policy/catalog");
    expect(JSON.parse(catalog).policies.length).toBeGreaterThan(0);
    const taxonomy = await conn.readResource("mercury://reference/error-taxonomy");
    expect(JSON.parse(taxonomy).categories.length).toBe(9);
  });
});
