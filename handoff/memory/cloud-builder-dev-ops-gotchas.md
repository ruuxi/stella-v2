---
name: cloud-builder-dev-ops-gotchas
description: "Operational facts for verifying workers/cloud-builder against the dev deployment (rollout counter lag, lossy tail, token scopes, retire script)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6d3e2693-c7e7-42dc-937f-929377491643
  modified: 2026-09-04T00:15:53.698Z
---

Learned 2026-09-03 while running the compute-ladder handoff's verification steps on dev (`stella-v2-cloud-builder-dev`).

- An image-changing deploy rolls the container app; for ~10 min the platform still counts old instances against `max_instances`, so a new attach loops on "Maximum number of running container instances exceeded" and the retire script's exact-live check flaps. Wait for `wrangler containers info` health to settle before reaping or timing a cell.
- `wrangler tail` drops most logs of long Durable Object invocations. Workers Logs are enabled but the telemetry query API needs an observability scope neither the wrangler login nor the Convex-held `CLOUDFLARE_API_TOKEN` has (that token also cannot list containers; the wrangler login can).
- Reap with `scripts/retire-sandbox-instances.mjs --config wrangler.jsonc ... --adapter scripts/retire-sandbox-adapter.mjs`; `CLOUD_BUILDER_URL` and `BUILDER_SERVICE_SECRET` come from `bunx convex env` in `packages/backend`.
- `cloud-turn.mjs` exits on the orchestrator's first completed row; poll `agent_events` for the agent thread yourself, and pass `--email` plus `--conversation` for a follow-up.
- `check:ratchet` runs from the repo root; the promise lint the handoff calls `lint:promises` is the root script `bun run cloud-builder:lint:promises` (eslint over workers/cloud-builder/src).

**Why:** each of these cost 10 to 30 minutes of misdiagnosis (a "leak" that was rollout lag, a teardown that looked absent because the tail dropped it).

**How to apply:** when a container looks leaked, check `wrangler containers instances` state first, then the app health block, then wait out a rollout before concluding. Related: [[abuse-protection-shipped]], [[do-placement-follows-first-caller]].
