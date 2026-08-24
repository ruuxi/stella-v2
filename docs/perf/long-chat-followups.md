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

## Larger runtime-memory follow-up

Completed and idle runtime state is now durably evicted and reconstructed from
SQLite, but a single active Pi turn can still retain its live `Agent.state.messages`
until that turn reaches an idle boundary. Fully moving a never-idle active turn
out of core requires a Pi/session checkpointing design that preserves prompt-cache
stable prefixes, tool-call continuity, and abort/retry correctness. Treat that as
a separate runtime architecture project rather than truncating live state.
