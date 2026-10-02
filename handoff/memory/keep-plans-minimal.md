---
name: keep-plans-minimal
description: "User pushed back on a multi-step plan (doctor script, devcontainer, per-vendor hooks) as overcomplicated; prefer the smallest thing that works"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ec279b50-2012-4c17-a91b-bc637b7f9768
  modified: 2026-09-02T22:18:57.019Z
---

When proposing infrastructure or process changes, give the minimal version first: one script, one file, no scaffolding layers (doctor commands, devcontainers, per-vendor hooks) unless asked.

**Why:** on 2026-09-02, after I proposed a six-step plan for making cloud agents self-provisioning, the user said "i thin ur overcomplicating it".
**How to apply:** lead with the two or three things that actually close the gap; mention extras in one line at most. Related: [[use-codex-agents-and-review-diffs]].
