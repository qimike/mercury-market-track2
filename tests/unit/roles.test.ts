import { describe, expect, it } from "vitest";
import { isToolAllowedForRole, ADVISOR_ALLOWED_TOOLS, HUMAN_EXECUTION_ONLY_TOOLS } from "../../src/domain/roles.js";

describe("role/permission model", () => {
  it("never allows the advisor_agent role to call a human-execution-only tool", () => {
    for (const tool of HUMAN_EXECUTION_ONLY_TOOLS) {
      expect(isToolAllowedForRole(tool, "advisor_agent")).toBe(false);
    }
  });

  it("allows human_support_agent to call human-execution-only tools", () => {
    for (const tool of HUMAN_EXECUTION_ONLY_TOOLS) {
      expect(isToolAllowedForRole(tool, "human_support_agent")).toBe(true);
    }
  });

  it("allows the advisor_agent role to call every explicitly advisor-allowed tool", () => {
    for (const tool of ADVISOR_ALLOWED_TOOLS) {
      expect(isToolAllowedForRole(tool, "advisor_agent")).toBe(true);
    }
  });

  it("has no overlap between advisor-allowed and human-execution-only sets", () => {
    for (const tool of HUMAN_EXECUTION_ONLY_TOOLS) {
      expect(ADVISOR_ALLOWED_TOOLS.has(tool)).toBe(false);
    }
  });

  it("rejects an unknown tool name for every role", () => {
    expect(isToolAllowedForRole("delete_everything", "advisor_agent")).toBe(false);
    expect(isToolAllowedForRole("delete_everything", "human_support_agent")).toBe(false);
  });
});
