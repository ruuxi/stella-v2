---
name: reply-refs-and-focus-view
description: "2026-09-02 decision: orchestrator cites replies via a trailing ```refs fence (#seq / agent:thread_id); iMessage-style reply previews + focus (lineage) overlay replace the agent-thread transcript tab"
metadata: 
  node_type: memory
  type: project
  originSessionId: e7486ecd-9955-4324-a984-4f093d3a453c
  modified: 2026-09-03T02:58:26.536Z
---

On 2026-09-02 the user chose this design for keeping the single chat readable under many concurrent tasks:

- The model decides what a reply is about. It ends a reply with a fenced block tagged `refs`, one line per target: `#<seq>` for a message (user turns carry a trailing `<system-reminder>message #N</system-reminder>` tag), `agent:<thread_id>` for a task. The block is stripped from every user-facing copy; the model's thread history keeps it. Contract lives in `packages/contracts/reply-refs.ts`; refs resolve in the worker (`resolveReplyRefs`), unknown targets drop silently, lifecycle turns fall back to the agent from the response target.
- Storage: `entry_ref` table (schema v2) indexed from `metadata.runtime.replyRefs` on every assistant row write; `listLineageMessages` / `listReplyCounts` in `ChatLog`.
- UI is iMessage only: preview bubble above the reply (agent previews expand the agent's full report, fetched on hover intent), "N replies" under originals and on task rows, and a focus overlay that dims the timeline to one message's or task's lineage.
- The read-only agent-thread transcript tab (`AgentThreadChatTab`, `listAgentThreadMessages`) was deleted; Tasks rows, inline cards, and Home rows open focus instead.

**Why:** the user explicitly wanted no separate agent chat view ("no normie is going to want to look at what the agent is doing"), no change to the agent result format, and only the iMessage UX. Full agent reports are the detailed view, so no second verbose reply is needed.
**How to apply:** extend the refs fence rather than adding new reply metadata channels; keep chips derived from stored refs; do not reintroduce a thread transcript viewer. Typing-in-focus context attachment was deliberately left out of the first cut. See [[stella-product-model]].
