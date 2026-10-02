---
name: cloud-lifecycle-rows-pending
description: Cloud-executed turns show no spawn/follow-up/completion rows in the chat timeline; lifecycle records in the cloud journal are pending work (2026-09-03)
metadata: 
  node_type: memory
  type: project
  originSessionId: fc31b8c3-61fb-41eb-9f77-4c05aa91f8d8
  modified: 2026-09-04T02:37:39.423Z
---

As of 2026-09-03, cloud-executed turns render no shimmering "agent started" row, follow-up rows, or completion card in the desktop timeline. The rows are built from `agent-started`/`agent-completed` lifecycle events that only the on-device runtime persists; the cloud journal projection (`packages/desktop-ui/src/features/cloud/journal-activity-files.ts`) emits only tool results and file cards. The 2026-09-02 reply-refs/focus commit (9b378b085) did not remove them.

**Why:** The user noticed the rows vanished and initially blamed the chat UI commit. The real cause is the shift to cloud execution. They want the rows back but deferred it until their in-flight cloud-builder/world work lands.

**How to apply:** When asked to restore them, add lifecycle records to the cloud journal and project them into the same event shapes the local path uses, rather than changing the renderer. Do not touch the uncommitted cloud-builder/executor-cloud files in the working tree; they belong to that outside work. See [[world-do-decision]] and [[reply-refs-and-focus-view]].
