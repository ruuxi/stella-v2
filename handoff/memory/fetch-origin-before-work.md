---
name: fetch-origin-before-work
description: Other sessions push to origin/master and deploy dev; fetch/rebase before starting work and always before any dev deploy
metadata:
  node_type: memory
  type: feedback
  originSessionId: 53cfdb37-b553-4192-9505-c698600ee951
  modified: 2026-10-01T21:10:30.419Z
---

On 2026-10-01 a dev deploy of `stella-v2-cloud-builder-dev` failed on Durable Object migration tag `v10`, which existed only on origin/master (another session's "Run cloud sandboxes on Sandbox SDK 1.0" deleted `SandboxSmall`/`AppBuildSandbox` and deployed). I had built 25 commits on a stale local master and nearly hand-wrote a conflicting v10/v11 migration. The user asked "maybe u didn't pull before starting this work?"

**Why:** several Claude/Codex sessions commit straight to master and deploy the shared dev deployment; the local checkout goes stale within hours.

**How to apply:** `git fetch origin master` and rebase onto it before starting a work chunk, and again right before any `wrangler deploy` or `convex dev/deploy`. A migration-tag or schema mismatch on dev means "pull first", never "invent the missing migration". After deploying, push master so other sessions don't redeploy older code over it. Related: [[decide-dont-ask]], [[cloud-builder-dev-ops-gotchas]].
