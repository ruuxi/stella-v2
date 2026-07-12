# Stella relay Responses resume

Stella's managed OpenAI Responses relay provides relay-owned, cursor-based
stream recovery without enabling provider response storage. Upstream requests
continue to send `store: false`.

## Protocol

For an authenticated, streaming OpenAI Responses request on the managed relay,
the initial response advertises:

- `x-stella-relay-resume: 1`
- `x-stella-relay-request-id: <opaque id>`

The relay assigns each parsed response event a monotonically increasing
`stella_relay_sequence`. A client that loses the connection after receiving
events reconnects with `GET /responses/<relay request id>?starting_after=N`.
Events at or below `N` are not replayed by the relay and are also deduplicated
by the client. The original `POST` is never repeated after any event has been
delivered.

Resume identifiers are scoped to the authenticated Convex owner. A request by
another owner receives the same not-found response as an unknown identifier.
Concurrent resume requests are read-only views of immutable event chunks, so
they cannot advance or consume a shared cursor.

## Retention and privacy

The relay stores only what is necessary to replay the downstream SSE stream:

- opaque relay request id and owner id;
- safe upstream/response identifiers and last event/status diagnostics;
- parsed downstream response event frames and their relay sequence numbers.

It does not store request bodies, prompts, input messages, tool definitions,
provider credentials, or request headers. Response frames can contain model
text and tool-call arguments, so they are treated as owner-private transient
data.

Each stream has a fixed ten-minute TTL and is capped at 4 MiB, 8,192 events,
and 256 KiB per event. Exceeding a cap disables resume for that stream and
fails closed without replaying the request. A scheduled cleanup removes expired
streams and chunks every five minutes. User data reset and account deletion
remove the owner's streams immediately instead of waiting for TTL cleanup.

## Failure behavior

The originating relay action keeps consuming and buffering upstream events if
the downstream socket disconnects. A new relay process can therefore resume
from persisted chunks while the originating action remains alive. Heartbeats
mark active streams; if an action disappears during a process restart or
redeploy, a resume request marks the stream lost after 30 seconds and returns a
terminal relay error. It never attempts to recreate provider work.

Completed, failed, and error streams replay their remaining persisted events
and terminate. Expired cursors return HTTP 410, cursors ahead of persisted
state return HTTP 416, and missing or cross-owner identifiers return HTTP 404.
Client abort stops reconnect attempts and sends an authenticated, idempotent
`DELETE /responses/<relay request id>` signal. The originating action observes
that durable canceled state, stops consuming the upstream body, and retains a
terminal cancellation record until normal cleanup. An ordinary socket loss is
deliberately not treated as cancellation because it must remain resumable.
