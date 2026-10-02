---
name: build-session-module-layout
description: 2026-09-04 split of workers/cloud-builder/src/index.ts (15.5k lines) into src/build-session/* modules with a structural host interface; rules for adding BuildSession behavior
metadata: 
  node_type: memory
  type: project
  originSessionId: 6d3e2693-c7e7-42dc-937f-929377491643
  modified: 2026-09-04T05:25:46.421Z
---

On 2026-09-04 `workers/cloud-builder/src/index.ts` (15,497 lines, the `BuildSession` DO plus the Worker router) was split into `src/build-session/`: `shared/{env,types,errors,keys}.ts`, `host.ts` (`BuildSessionInternals`, the structural surface of the class), and behavior modules `session-core`, `admission`, `resident-turn`, `container-turn`, `session-sandbox`, `turn-broker`, `terminal-delivery`, `alarms-recovery`, `app-build`, `owner-purge-transfer`, `owner-fence-leases`, `worker-router`. index.ts is ~1,570 lines: DO class shells, delegators, `export default worker`. Plan: `~/Documents/stella-build-session-split-plan.md`.

**Why:** every change to turn lifecycle had to hold the whole file in view; codex units took an hour each mostly reading it. The user approved the split (done by parallel Opus subagents in worktrees, four batches, router last).

**How to apply:**
- New BuildSession behavior goes in the matching module as `export const fn = async (host: XHost, …)`; `XHost = Pick<BuildSessionInternals, …>`; add the signature to `host.ts` if another module calls it; the class keeps a one-line delegator only when tests stub it by name or another module/router calls it on the instance.
- Modules never import each other; cross-cluster calls go through `host`. Helpers shared by several modules live in `shared/keys.ts`.
- Intra-module calls to methods that keep a delegator stay `host.name(...)` because tests stub them on the instance.
- `import type` for host/types/env; never add build-session modules to `tests/fixtures/resident-import-graph.ts`.
- `scripts/cloud-canonical-real-product-driver.mjs` anchors on source text in `session-core.ts` and `container-turn.ts`; `tests/cloud-canonical-real-product-manifest.test.mjs` checks it.
- Merge lesson: parallel extraction branches conflict only in import blocks and in "both sides removed different names" hunks; resolve name-list hunks by intersection, never by concatenation.

See [[world-do-decision]], [[codex-full-access-always]].
