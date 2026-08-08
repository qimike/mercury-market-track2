# Sessions and scratchpads rules

- Resume restores facts, issue state, and scratchpad entries, and honors an
  approval only when its current hash exactly matches the approved hash —
  never on a looser match.
- Fork (`src/agent/session.ts`'s `forkSession`) gets its own `CaseContext`
  and a `readOnlySession: true` MCP connection — it must never share or copy
  the parent's approval state, and must never permit a side effect based on
  a parent decision.
- `src/sessions/scratchpad.ts`'s `copyScratchpadForFork` only carries over
  entries already tagged `verified` or `resolved` — open questions,
  contradictions, and hypotheses stay with the parent.
- Scratchpad entries are typed (`ScratchpadCategory`/`ScratchpadStatus`) and
  must never store secrets, passwords, full payment credentials, or
  unnecessary personal data — `assertSafeStatement` is the guard; don't
  bypass it.
- Never store private chain-of-thought anywhere in a session, scratchpad, or
  audit record — persist facts, decision summaries, tool events, validation
  results, citations, proposed actions, human decisions, and execution
  results only.
