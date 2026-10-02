---
name: codex-full-access-always
description: Run codex agents with -s danger-full-access always (user instruction 2026-09-03); the workspace-write sandbox blocks workerd/Docker/loopback and wastes verification
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6d3e2693-c7e7-42dc-937f-929377491643
  modified: 2026-09-04T03:19:01.999Z
---

Always launch codex agents with `-s danger-full-access` (the codex-agent skill's flag; it passes `--dangerously-bypass-approvals-and-sandbox`). The user said on 2026-09-03: "just full access codex going forward, always."

**Why:** Codex's `workspace-write` sandbox (landlock + seccomp) blocks all sockets including loopback listeners, the Docker socket, and writes outside the repo (e.g. `/run/user/1000`). Every workerd fixture and Docker-backed test then fails inside the agent, it reports 15 to 18 "environment-bound" failures it cannot reproduce, and real bugs (a WorldStore `diff` bug in Step 2) hide behind them until I re-run outside.

**How to apply:** pass `-s danger-full-access` on every `codex-agent.sh` call in this repo; the user's standing approval covers it. Still verify the reports myself. See [[use-codex-agents-and-review-diffs]], [[cloud-builder-dev-ops-gotchas]].
