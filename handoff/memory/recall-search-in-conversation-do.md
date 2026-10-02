---
name: recall-search-in-conversation-do
description: "2026-09-01 decision — Recall's index lives in the conversation Durable Object (SQLite FTS5), not in Convex; Convex excerpt/thread-message/legacy transcript tables are deleted"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5af2db59-ccd1-40ee-b236-69a446068c59
  modified: 2026-09-02T03:59:25.373Z
---

Decision (2026-09-01, in progress that evening via Codex agents): the Recall tool searches an FTS5 index inside the conversation Durable Object's own SQLite (`workers/cloud-builder/src/transcript-search.ts`, mounted by `journal.ts`), indexing only user/assistant message text, surviving rollover to R2, with hits hydrated to the real journal records around each seq (via `archive.readRange`). Recall never calls Convex mid-turn. Deleted from Convex: `cloud_message_excerpts` + `/api/cloud/recall`, the `excerpts` field of `conversation.index` outbox events and the `/reindex` route, the `cloud_thread_messages` projection + `thread.messages` outbox event (no reader existed), and the legacy `cloud_messages` table + drain cron. The same index module is mounted on the BuildSession thread transcript so agents could get Recall later without redesign. `CONVERSATION_MAX_STORED_BYTES` raised from 256 MiB to 4 GiB.

Platform facts checked: DO SQLite is 10 GB per object, FTS5 works there (Cloudflare Agents SDK uses it), DO SQL storage is $0.20/GB-month vs R2 $0.015, hence messages stay tiered (SQLite hot set + R2 segments) and only the text index stays resident.

**Why:** the previous implementation searched a truncated per-turn digest copied to Convex, was lossy, and made a synchronous Convex call during a turn, violating the two-plane rule in [[greenfield-two-plane-architecture]]. The user called it "definitely wrong".
**How to apply:** do not reintroduce Convex-side transcript copies or cross-conversation/semantic search; see [[stella-product-model]]. Follow-ups from the same investigation, both done 2026-09-01 evening: OwnerGate now takes pushed snapshots from Convex and serves its cached copy with background refresh (only a gate with no snapshot blocks, 3 s timeout); the cloud-builder script dropped from 10.47 to 6.77 MB by making provider registration an explicit per-host call (`registerBuiltInApiProviders()` at Node entries, `registerCloudApiProviders()` in the Worker) instead of a side effect of importing `ai/stream.ts`. Startup-evaluated code is still ~5.7 MB (effect, zod via storage/shared, typebox/ajv, sandbox SDK); a hibernated conversation object's wake is bounded by that plus SQLite bootstrap, so further wins need a script split, not a diet.
