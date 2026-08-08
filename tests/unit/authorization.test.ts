import { describe, expect, it, afterEach } from "vitest";
import { authorizeExecution } from "../../src/mcp/authorization.js";
import { recordApproval, _resetApprovalStoreMockState } from "../../src/approvals/store.js";

afterEach(() => _resetApprovalStoreMockState());

const validContext = {
  humanActorId: "human_1",
  suggestionId: "sugg_1",
  suggestionVersion: 1,
  suggestionHash: "a".repeat(64),
  actionId: "action_1",
  actionVersion: 1,
  actionHash: "b".repeat(64),
};

describe("authorizeExecution (defense-in-depth, independent of tool registration)", () => {
  it("blocks advisor_agent unconditionally, even with a perfectly valid execution context", () => {
    recordApproval({
      suggestionId: "sugg_1", suggestionVersion: 1, suggestionHash: "a".repeat(64),
      actionId: "action_1", actionVersion: 1, actionHash: "b".repeat(64),
      status: "approved", reviewerReference: "human_1", decidedAt: "2026-08-07T00:00:00.000Z",
      forkedFromSessionId: null, executedAt: null, executedTransactionRef: null,
    });
    const decision = authorizeExecution("process_refund", "advisor_agent", false, validContext);
    expect(decision.allow).toBe(false);
    expect(decision.blockedError?.errorCode).toBe("ADVISOR_SIDE_EFFECT_FORBIDDEN");
  });

  it("allows non-execution tools regardless of role", () => {
    expect(authorizeExecution("get_customer", "advisor_agent", false, undefined).allow).toBe(true);
  });
});
