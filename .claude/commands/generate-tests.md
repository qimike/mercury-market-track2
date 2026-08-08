---
description: Generate or update focused tests for policies, prompts, schemas, tool contracts, and governance logic.
---

# /generate-tests

Inspect a specified policy, prompt, example, schema, MCP description, approval flow, or governance rule.

Then:

- identify affected scenarios
- create or update focused tests
- include positive, negative, boundary, authorization, security, and regression cases
- preserve project testing conventions
- run the narrowest relevant tests when execution is permitted
- report generated files and actual outcomes

Do not replace meaningful assertions with snapshots alone.
Do not claim tests passed unless the relevant test command actually ran successfully.
