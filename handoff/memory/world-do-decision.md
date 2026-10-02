---
name: world-do-decision
description: "2026-09-03 five-step plan for cloud agents — per-owner world DO, no quotas, no world lease, cloud generals spawn, shared container per owner, sync at command boundaries, isolation on request"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6d3e2693-c7e7-42dc-937f-929377491643
  modified: 2026-09-04T00:49:04.399Z
---

Decided 2026-09-03 by the user for `workers/cloud-builder` (supersedes the earlier 4.1/4.2 note). Greenfield: no users, no existing worlds, delete replaced code, skip every migration step. Each step lands as its own commit.

**Target semantics:** the cloud copies the local model. One filesystem per owner shared by every agent, no locks, last writer wins. Orchestrator spawns any number of agents; agents spawn subagents to depth 2; isolation is requested, not default.

**Storage:** per-owner world DO named `${ownerHash}:${workspaceHash}`; content-addressed chunked FS in its SQLite (nodes, dirents, 512 KiB chunks by sha256, manifests, tombstones); blobs above a few MiB spill to a new worlds R2 bucket. Tools live inside it over RPC: read, write, edit, apply patch, grep, glob, list, fork, merge. BuildSession do_local tools call that surface. Never put world bytes in BuildSession or OrchestratorSession.

1. **Policy first:** delete cloud plan quotas (`packages/backend/convex/cloud_apps.ts`) and owner-gate burst/daily/concurrency enforcement; token metering via the model-gateway capability budget is the only product limit. Keep `max_instances` and sleep-after as physical guards; raise small-class `max_instances` in production. Delete one-agent-per-owner-world at spawn admission and the world lease plus its destroy coupling entirely. Add `spawn_agent`, `send_input`, `pause_agent`, `agent_status` to the cloud general catalog as do_local; move the orchestrator's spawn dispatch into a shared module; child carries `parentThreadId`, is its own BuildSession, never a facet; completion wakes the parent's running loop as a steer message, falling back to the orchestrator wake; depth limit 2; a grandchild loses the four tools (as desktop does).
2. **World object:** build the DO and RPC; `Read`/`apply_patch` → do_local; add `Write`, `Edit`, `Grep` with `*-def.ts` descriptor modules (parity test); checkpoint is `{historyCursor, manifestId}` only; delete the workspace target kind in `turn-state-archive.ts`/`turn-state-checkpoint.ts` (keep native for Claude Code state); delete remembered instance size in KV.
3. **One shared container per owner world:** sandbox id from owner plus workspace, not turn attempt; each agent creates its own session and daemon on its own socket path; cold start materializes from the world DO's current manifest; container never owns the world.
4. **Sync at command boundaries:** after each `exec_command`/`write_stdin` the daemon pushes changed files as chunks with a manifest diff (path, mode, sha256, size); before a command it pulls others' changes since its last sync; quiesce does one final push. Replaces end-of-turn write-back.
5. **Isolation on request:** spawn arg `workspace: "new" | "fork"`; fork = own manifest over the same chunks; new = empty world seeded with the stella checkout; such an agent's session mounts its fork, sync targets it, completion reports files; merge back is an explicit tool call.

**Status 2026-09-04:** all five steps committed (`baac4aabd`, `371c4ada8`, `2e7a71a87`, `fa21869e6`, `c5332b5df`); index.ts split landed between 3 and 4; deployed to dev on 2026-09-04 (version 49a00c9b) with fixes `ad48df23a`, `dd3cb9ef2`, `7db17c776` and the seed/interior removal `bc014e974`; two-agent cell passes; staging/prod worlds buckets created; batched pushes + process-group teardown `5db86ff20` deployed as `34ae99c7`. Live status lives in `~/Documents/stella-world-do-design.md`.

**Decision 2026-09-04 (seed):** no `stella/` desktop-ui seed in the world and no `publish_stella_interior` tool; a new world is empty and an agent clones the repo itself if it needs it. The interior build/publish path is deleted, not kept optional. (Reason: the seed cost ~5 min of DO time per new owner world on first command; the feature is optional and can return later as a clone.)

**Constraints:** resident import graph must not reach `kernel/tools/host.ts`, `node:fs`, `child_process`, `worker_threads` (dynamic import for heavy modules); no new raw `setTimeout`/`AbortController`; rows under 2 MB; never call a container RPC on teardown without asking the sandbox object if it is running; workerd fixtures and catalog parity test green at every step.

Design note: `~/Documents/stella-world-do-design.md`. See [[cloud-builder-dev-ops-gotchas]], [[keep-plans-minimal]], [[use-codex-agents-and-review-diffs]].
