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
by the client. Once capability headers arrive, the client seeds cursor zero,
so even an EOF before event one reconnects with `GET ...?starting_after=0` and
does not repeat the original `POST`.

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
text, reasoning, citations, and tool-call arguments. They are stored as
owner-private transient application data in Convex and are not end-to-end
encrypted from Stella or Convex. This is intentionally disclosed in the
desktop Terms and Privacy Policy; the buffer is not used for training,
personalization, advertising, or analytics.

Each stream is capped at 1 MiB, 4,096 events, and 128 KiB per event. Per-owner
limits are eight streams and 4 MiB; service-wide limits are 2,048 streams and
256 MiB. Exceeding any cap disables resume for that stream and fails closed
without replaying the request.

Logical access expires two minutes after the latest live activity and has a
hard fifteen-minute lifetime from request start. Cleanup runs every minute,
deletes at most 16 documents and 256 KiB per mutation, drains up to 20 batches,
and reschedules itself until the backlog is empty. Cleanup lag and failed
sweeps are stored as content-free operational diagnostics. Physical rows are
normally removed within minutes after logical expiry, but scheduler outages,
backlog, recovery systems, and provider-managed backups mean there is no
absolute physical-deletion guarantee. User data reset and account deletion run
the same bounded deletion until the owner's active rows are gone.

## Failure behavior

The originating relay action keeps consuming and buffering upstream events if
the downstream socket disconnects. A new relay process can therefore resume
from persisted chunks while the originating action remains alive. Heartbeats
mark active streams; if an action disappears during a process restart or
redeploy, a resume request marks the stream lost after 30 seconds and returns a
terminal relay error. It never attempts to recreate provider work.

Completed, failed, and error streams replay their remaining persisted events
and terminate. Incomplete responses are terminal and retain the provider's
incomplete reason for correct client stop-reason mapping. Expired cursors
return HTTP 410, cursors ahead of persisted state return HTTP 416, and missing
or cross-owner identifiers return HTTP 404.
Client abort stops reconnect attempts and sends an authenticated, idempotent
`DELETE /responses/<relay request id>` signal. The originating action observes
that durable canceled state, stops consuming the upstream body, and retains a
terminal cancellation record until normal cleanup. An ordinary socket loss is
deliberately not treated as cancellation because it must remain resumable.
If DELETE wins the race before POST reservation, the relay retains only the
opaque request id, owner id, and a two-minute cancellation expiry; reservation
then fails canceled without starting upstream work. These content-free
cancellation tombstones use the same bounded cleanup and owner-deletion path.

Resume reads use the `(relayRequestId, lastSequence)` index and return at most
two 64 KiB chunks per query. The HTTP response is pull-driven so database reads
follow downstream demand. Caught-up polling backs off from 100 ms to 1 second.
Resume requests are rate-limited per owner and stream and protected by expiring
leases that allow at most two consumers per stream and eight per owner.
