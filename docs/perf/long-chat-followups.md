# Long-chat performance follow-ups

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
