# Mobile long-chat durability and recovery

## Ownership

| Surface | Canonical transcript | Rendered window | Remote authority |
| --- | --- | --- | --- |
| Cloud Chat | `mobile_chat_messages` in `stella-mobile-transcripts.db` | Recent 160 rows, paged by 80, capped at 480 | None |
| Computer Chat | The same mobile SQLite repository is the durable phone cache | Same bounded window | Desktop local-chat SQLite remains authoritative |
| CarPlay | Its own `carplay` or `carplay-computer` thread in the mobile repository | Bounded recent hydration; no history browser | Cloud or desktop transport, respectively |
| Bun/web tests | Uncapped AsyncStorage compatibility repository | Same paging API | None |

AsyncStorage's old whole-array keys are migration inputs, not the native source
of truth. Sync cursors, outbox records, and the Cloud summary checkpoint remain
small AsyncStorage metadata. Sign-out clears transcripts, migration markers,
sync cursors, outbox state, checkpoint/memory metadata, and the separate FTS
recall index.

Cleanup broadcasts synchronously to every mounted chat owner before deleting
storage. Each owner cancels streams, paging, sync, queues, and debounced writes
and clears its rendered state; storage generations cover all four thread IDs,
including both CarPlay stores. The derived index is wiped only after canonical
transcript cleanup settles, preventing a late mirror from repopulating it.

## Durable ordering and identity

Each mobile row preserves its local `id` and `createdAt`, optional desktop
`canonicalId` and `canonicalCreatedAt`, desktop `sequence`, and the full UI
payload (tasks, artifacts, tool steps, images, queued/stopped state, and
`requestId`). Stable local IDs remain LegendList keys after reconciliation.

SQLite paging uses `(order_key, message_id)` keysets. New runs are normally
placed before, after, or between sparse adjacent keys, so a bounded save cannot
delete unloaded history. If repeated middle insertion exhausts floating-point
precision, the repository transactionally rebalances the durable keys once and
retries. Page cursors carry stable message IDs and re-resolve the row's current
key, so a cursor captured before rebalancing remains valid. Explicit rewind is
the only transcript-tail deletion operation.

Computer Chat's remote history endpoint reuses desktop local-chat's strict
`(beforeTimestampMs, beforeId)` keyset. It returns rows oldest-to-newest and
projects current task/artifact state for task IDs touched by an old page. Every
projection also carries the durable source row's ID/timestamp, and the page
returns a separate oldest-source cursor. Synthetic task rows and pages whose
visible projection is empty therefore cannot corrupt or stall traversal.
Desktops without `localchat-history-before-v1` use progressively larger recent
windows only after an explicit user page request, capped at 1,000 rows.
Capability selection and the compatibility cursor slice live in
`desktop-history-pagination.ts`, independently testable from bridge crypto.

## Write and migration behavior

Native writes are serialized and transactional. `saveChatMessages` receives a
bounded loaded slice, allocates order keys only for unknown rows, serializes
that slice, and upserts only changed payloads. Missing rows never imply
deletion. The hook narrows debounced writes to referentially changed rows plus
one stable ordering neighbour on each side, so a streaming frame normally
serializes three rows rather than the rendered window. It never reads or
rewrites the durable transcript. Native order/payload caches are bounded at
twice the 480-row loaded-window limit, leaving room for every loaded row and
its paging anchors without turning Hermes memory into a transcript mirror.
Transcript generations invalidate queued pre-rewind writes so a stale
debounce cannot resurrect a deleted tail.

Legacy migration is idempotent:

1. Read the old AsyncStorage array defensively, dropping only corrupt rows.
2. In one SQLite transaction, `INSERT OR IGNORE` every row and write the
   per-thread `legacy-migration-v1` completion marker.
3. Remove the old key only after the transaction commits.

A kill before commit rolls back rows and marker, so the source is retried. A
kill after commit leaves a marker that wins over a redundant old key. Concurrent
migrations serialize; primary-key inserts prevent duplicates.

If `expo-sqlite` is absent (Bun and non-native environments), the repository
uses an explicit serialized, uncapped AsyncStorage fallback. It stores bounded
128-row copy-on-write pages, commits the manifest last, tracks garbage for a
later sweep, and treats per-message locators as repairable hints. It pages and
merges bounded writes instead of reading or replacing the whole transcript.
Native SQLite open and schema failures remain visible and retryable; they do
not silently switch the app to a second canonical store.

The FTS recall database remains a derived store. Its initial mirror scans
canonical Cloud history oldest-first in bounded pages and writes a durable
completion marker only after the final page. A kill mid-scan restarts through
idempotent upserts rather than leaving an incomplete index marked done. Rewind
persists a separate rebuild-required marker and blocks indexing before
truncating the canonical transcript, then unblocks and rebuilds from the
surviving rows. A kill on either side of truncation therefore repeats a safe
canonical rebuild. Generation guards keep an older in-flight backfill from
marking the rebuilt index complete. Rebuild ownership uses serialized tokenized
intents, so stale initialization or cleanup cannot clear a newer owner's marker.
Index write failures reject into the persistence retry path instead of being
reported as a successful mirror, while the missing completion marker guarantees
another canonical backfill attempt after restart.

## Context and memory bounds

Cloud dispatch builds context from the durable recent tail, not from whichever
older page happens to be visible. Compaction stores a rolling summary plus a
single `coveredThroughId` watermark; older `coveredIds` checkpoints remain
readable. A row-count trigger protects chats made of many tiny messages, while
the token trigger protects normal prose. Model context keeps a contiguous
recent tail of at most 160 messages and clips an individual historical message
above 12,000 characters. Rolling summaries are also clipped to 12,000
characters, and framing overhead is included in compaction budgets. Existing
long transcripts bootstrap a missing checkpoint oldest-first in bounded,
hierarchical passes; `bootstrapPending` makes a kill restart from raw durable
rows rather than trusting a partial summary. The persisted and rendered
Markdown is never clipped.

Rewind deletes durable rows from the selected message onward and clears the
checkpoint. This prevents a summary from referring to turns the user removed.

## Paging and reconnect behavior

LegendList uses stable message IDs and visible-content anchoring while older
rows are prepended or newer rows are appended. Paging evicts from the opposite
edge at 480 loaded rows and records that an adjacent page remains available.
The durable repository is not evicted.

CarPlay consumes only the bounded recent window and exposes a fixed number of
recent assistant replies. It does not mount the history browser, so paging and
edge eviction cannot add work to its native template updates or reply lookup.

Computer Chat never starts an ordinary pull while a send is active. Pushes,
foreground requests, and reconnect catch-ups are merged into one deferred
intent; catch-up is sticky. After optimistic/canonical reconciliation settles,
the deferred request runs. This avoids both lost gap notifications and the
optimistic/canonical duplicate-user race.

## Recovery playbook

- **Migration repeats after a crash:** leave the old key in place. Relaunch;
  the transaction marker and primary key make the retry safe.
- **`expo-sqlite` absent in Bun/non-native tests:** the explicit paged
  AsyncStorage fallback is canonical for that environment.
- **Native SQLite open/schema failure:** the failure remains visible and
  retryable. Diagnose or repair SQLite; the app does not silently change stores.
- **Computer history appears to stop early:** reconnect or update the desktop.
  A compatible desktop serves keyset pages; an old desktop intentionally stops
  at the 1,000-row compatibility ceiling.
- **Computer cursor gap:** trigger the existing catch-up/Force Sync path while
  idle. It ignores a poisoned delta cursor and merges a bounded full window.
- **Cloud summary is stale after rewind:** rewind already clears it. If storage
  was externally edited, remove `stella-mobile-chat-checkpoint-v1`; raw rows are
  unaffected.
- **Corrupt row:** hydration skips that row only. Other SQLite rows and pages
  remain available.

## Deterministic verification

The focused suites cover 10,000-row paging, bounded incremental saves,
transaction interruption/retry, concurrent migration, truncation, 100,000 push
events, deferred reconnect gaps, old-history task projection, strict desktop
keysets, and oversized Markdown context. Run:

```sh
bun test packages/mobile/src/lib/__tests__/offline-chat-storage.test.ts \
  packages/mobile/src/lib/__tests__/offline-chat-tools.test.ts \
  packages/mobile/src/lib/__tests__/chat-transcript-window.test.ts \
  packages/mobile/src/lib/__tests__/desktop-history-pagination.test.ts \
  packages/mobile/src/lib/__tests__/desktop-sync-policy.test.ts
bun run test:electron -- tests/electron/mobile-sync-task-context.test.ts
bun run mobile:typecheck
bun run electron:typecheck
```
