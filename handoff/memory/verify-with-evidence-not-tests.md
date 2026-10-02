---
name: verify-with-evidence-not-tests
description: "2026-10-01: don't write tests (agent tests just restate the code); prove changes live in the real product with evidence"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 53cfdb37-b553-4192-9505-c698600ee951
  modified: 2026-10-01T21:07:03.320Z
---

On 2026-10-01 the user said tests are useless ("the agent will just reoutput the same exact code and call it a test. we shouldn't do tests. we should just actually verify with proof/evidence").

**Why:** agent-written tests mirror the implementation and prove nothing; only behavior observed in the running product counts.

**How to apply:** don't add new unit/e2e test files or port acceptance harnesses. Verify by driving the real app (`.agents/skills/verify-stella`, live dev deployment, logs, DB readback) and report the observed evidence. Keep existing suites green when touching code, but don't grow them. Stale live acceptance drivers get deleted, not ported.
