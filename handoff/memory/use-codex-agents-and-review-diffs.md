---
name: use-codex-agents-and-review-diffs
description: No Codex delegation; for parallel lanes use Claude subagents in worktrees with me as integrator (2026-10-01)
metadata:
  type: feedback
---

Don't hand work to Codex unless asked (user stopped a Codex run 2026-09-23: "dont have codex do stuff ... u do it").

2026-10-01: the user asked to parallelize independent lanes with Claude subagents, each `isolation: worktree`, with a full self-contained brief (they don't see the conversation) and the cross-lane interface agreed before launch. I stay the integrator: review each diff, merge, then do deploys and live verification myself, one at a time, never in parallel. Don't run work touching the same hot file (e.g. orchestrator-session-object.ts) in parallel lanes.

**How to apply:** subagents never deploy, push, or launch Electron; they commit in their worktree and report. If Codex is ever requested again, use `-s danger-full-access` ([[codex-full-access-always]]).
