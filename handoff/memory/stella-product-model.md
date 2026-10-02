---
name: stella-product-model
description: "How Stella is meant to work as a product (single ongoing orchestrator chat, Recall scope, agent threads) — stated by the user 2026-09-01"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5af2db59-ccd1-40ee-b236-69a446068c59
  modified: 2026-09-02T03:55:58.946Z
---

Stella is one ongoing conversation with an orchestrator, not a many-chats product. "New chat" exists but is very secondary. Under the orchestrator are agent threads (spawned agents); in the cloud they run in BuildSession sandbox objects with their own SQLite transcript.

Recall (the orchestrator's memory tool) is meant to search the orchestrator's OWN conversation transcript from all time — the reason it exists is context compaction. It is NOT cross-conversation, NOT over agent threads, and semantic search is not wanted. A "new chat" recalls only its own transcript. Agents do not get Recall today; the user may add it later, so the search index module must be reusable by a thread transcript.

**Why:** the user said this explicitly on 2026-09-01 when we found the implemented Recall searched a truncated per-turn digest in Convex instead of the transcript.
**How to apply:** when touching Recall, transcripts, or "threads", keep scope to the current conversation; do not propose cross-conversation or semantic search. See [[recall-search-in-conversation-do]] and [[greenfield-two-plane-architecture]].
