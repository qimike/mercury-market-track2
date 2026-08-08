# MCP authorization rules

- Treat the advisor as read-only unless a human-approved path is active.
- Prevent direct refund or order mutation from the advisor.
- Validate identity, policy confidence, and approval state before executing any action.
- Reject unsafe or unverified tool calls before they reach the backend.
