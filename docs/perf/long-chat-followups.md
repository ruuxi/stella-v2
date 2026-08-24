# Long-chat performance follow-ups

## Medium: projected tool detail can be unreachable in an otherwise empty row

Locations:

- `packages/desktop-ui/src/features/chat/lib/assistant-row-content.js:18-28`
- `packages/desktop-ui/src/features/chat/lib/chat-timeline-items.ts:38-41`
- `packages/desktop-ui/src/app/chat/MessageRow.tsx:746-771`

`buildChatTimelineItems` can discard an assistant message whose authored text is
empty even when its `toolEventSummary` says lazy detail is available. The row is
removed before `MessageRow` can mount its **Show more** control. A direct-mode
preamble with suppressed text and only a projected non-artifact tool result can
therefore retain complete detail in SQLite without exposing the detail control.

Fix direction: count a truncated `toolEventSummary` (or otherwise available lazy
detail) as visible assistant-row content. Add a timeline-item regression with an
empty-text assistant, `sourceMessageId`, and a truncated summary, plus a row-level
test proving the detail control mounts and requests the complete durable page.

## Medium: make compaction waits and session disposal abort-aware

Locations:

- `packages/runtime/kernel/agent-runtime/pi-session-core.js`
- `packages/runtime/kernel/thread-runtime.ts`
- `packages/runtime/kernel/runtime-initialization.ts`

Model-switch and pre-turn compaction waits currently outlive prompt cancellation,
summary retry sleeps can add up to 18 seconds, and disposing a Pi session does not
invalidate already scheduled work. Add abort-aware waits without canceling a
durable write already in progress, and prevent disposed-session callbacks from
mutating live ownership or publishing stale notifications.

## Medium: preserve the newest owner when compaction requests coalesce

Locations:

- `packages/runtime/kernel/agent-runtime/compaction-scheduler.ts`
- `packages/runtime/kernel/agent-runtime/run-completion.js`

The per-thread scheduler keeps the first pending request's closure and only
chains later success callbacks. A newer session/model request can therefore run
under stale ownership and miss its `notifyCompacted()` path. Coalescing should
retain the latest valid execution owner while preserving every caller's required
completion notification.

## Medium: round-trip tool-result details through durable history

Locations:

- `packages/runtime/kernel/agent-runtime/run-events.ts`
- `packages/runtime/kernel/storage/shared.ts`

`PersistedRuntimeThreadPayload` omits `ToolResultMessage.details`, so page-in
reconstructs provider-visible content exactly but loses runtime metadata such as
file changes, produced files, and engine details. Define a bounded serializable
details contract and restore it during durable reconstruction.

## Low: benchmark the real boundary manager with equal retention counts

Location:

- `packages/desktop-ui/benchmarks/long-chat-perf.bench.ts`

The active-working-set case loads a prepared overlay directly instead of driving
`handleActiveTurnBoundary`/`refreshActiveWorkingSetAtBoundary`, and its heap
comparison retains five current snapshots versus one legacy snapshot. Add an
end-to-end boundary benchmark and compare equal snapshot counts.
