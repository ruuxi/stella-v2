---
name: greenfield-two-plane-architecture
description: "2026-09-01 greenfield proposal for Stella - Cloudflare as sole data plane, Convex as sole control plane, request/response model calls"
metadata: 
  node_type: memory
  type: project
  originSessionId: 42a62454-6f62-4f8d-a4cc-92c1d948e663
  modified: 2026-09-02T01:15:39.006Z
---

On 2026-09-01 the user asked for a greenfield (not incremental) architecture to replace the Cloudflare -> Convex relay -> provider -> Convex -> Cloudflare turn path. Proposal written to ~/Documents/stella-greenfield-architecture.md: gateway Worker, conversation DO owns the whole turn, model gateway as a workerd-safe module (in-process for the DO, service binding for sandboxes, public route for desktop), signed capability tokens instead of per-request Convex lookups, per-owner gate DO for quota/placement/presence, one Cloudflare Queue outbox projecting into Convex. Convex keeps auth, billing, plans, catalogs, conversation index.

Confirmed in code: chat UX delivers whole messages (no token deltas anywhere except voice audio), so Stella's own loop can use request/response model calls. The relay does not force streaming; the Claude Code and Codex CLIs stream on their own with no switch, so their lane is a dumb byte pipe. Voice is the other exception, and the user has a worktree moving speech-to-text to streaming too.

Implementation status (2026-09-01, uncommitted working tree on master): Stage 1 done and green (workers/model-gateway, packages/model-catalog, contracts/gateway, Convex /api/gateway routes, relay + 8 resume tables deleted, runtime gateway-mode adapters, cloud-builder mints turn capabilities). Stage 2: orchestrator side (OwnerGate DO, DO-owned admission at POST /conversations/:id/turns, TURN_OUTBOX), Convex side (outbox ingest, owner snapshot, capability-verified callbacks, turn tokens and dispatch ladders deleted), and desktop client are done and green; the BuildSession/executor half is done too; Stage 2 integration gates were green on 2026-09-01 evening. Stage 3 (OwnerGate presence + placement, Convex placement deletion, desktop bridge/web shell/mobile clients) is done and green as of late 2026-09-01. All three stages are implemented but UNCOMMITTED and UNDEPLOYED; docs/cloud-apps.md is the operating guide and lists the deploy order and secrets. Pre-existing failures verified against a clean HEAD worktree: Convex managed_alternate_writer_inventory, desktop-ui context-model-precedence, mobile carplay dictation-provider-policy, one no-empty lint error, two docker-only sandbox-egress tests. Reviewed diffs and fixed: ledger abandoned-reservation release, OwnerGate bypass must not spend start windows, anonymous capabilities need GATEWAY_BUDGET_UNLIMITED not 0. The working plan with contracts and partition lives in the session scratchpad PLAN.md; if that is gone, the contracts under packages/contracts/{gateway,turn-plane} are the source of truth.

**Why:** the Convex HTTP-action relay has a ten-minute cap that forced a seven-table SSE resume journal, and auth/billing lookups sit on every token path.
**How to apply:** when discussing cloud turn architecture, start from this two-plane split and the non-streaming default rather than re-deriving; see [[docs-go-to-home-documents]].
