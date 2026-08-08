---
name: advisor-log-analysis
description: Summarize advisor and CI execution logs for loops, retries, validation failures, approval mismatches, and unsafe action attempts.
---

# Advisor log analysis

Use this skill to inspect large advisor or CI logs without reading the full file into the main context.

## Inputs

- A log file or log path
- Optional case/session/suggestion IDs

## Required analysis

1. Correlate the log by case ID, session ID, suggestion ID, issue ID, action ID, tool-call ID, or correlation ID.
2. Identify the first meaningful failure.
3. Distinguish root cause from downstream symptoms.
4. Classify retryable vs non-retryable failures.
5. Detect repeated tool calls, validation loops, and approval-hash mismatches.
6. Detect attempts to execute a side-effecting action from the advisor.
7. Redact sensitive data before reporting.

## Output contract

Return only:

- incident summary
- event timeline
- likely root cause
- evidence
- affected component
- recommended next checks

Do not modify production code unless the user explicitly asks for a fix.
