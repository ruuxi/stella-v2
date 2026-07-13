# Stella relay Responses resume

Stella's managed OpenAI Responses relay provides relay-owned, cursor-based
stream recovery without enabling provider response storage. Upstream requests
continue to send `store: false`.

## Protocol

Resume buffering is enabled for every authenticated, streaming OpenAI
Responses request on the managed relay. New clients propose a random relay id
in `x-stella-relay-request-id`. Older clients already reuse a stable,
per-request `Idempotency-Key`; the backend hashes that key together with the
authenticated owner to derive the same opaque relay id on every POST attempt.
Thus a repeated old-client POST reaches the existing reservation and streams
from cursor zero instead of allocating a second upstream execution. A request
that supplies neither a proposed relay id nor a usable idempotency key is
rejected before upstream work.

A newer client talking to an older backend fails closed: once it has
attempted the POST with its proposed id, any zero-event EOF or pre-header
transport failure advances to `GET ...?starting_after=0`. If that backend does
not implement resume, the GET fails and the POST is not replayed.

An older client talking to a newer backend may still select POST after a
pre-event transport failure, but it repeats the same `Idempotency-Key`. The
backend maps that attempt to the first relay stream and never repeats the
upstream request.

The initial response advertises:

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
hard ten-minute lifetime from request start. Ten minutes matches the Convex
HTTP-action lifetime that bounds the relay action producing events, so the
advertised resume window never promises more than the platform can serve.
Expiry is enforced on every delivery: each pull of the resume body revalidates
the consumer's lease and the stream's logical expiry before another frame is
handed out, the body is strictly demand-driven (`highWaterMark: 0`) so no
plaintext frame sits in an internal queue past that gate, and already-buffered
frames are replaced by a synthetic terminal error the moment access expires.
An open response refreshes its lease independently of reader pulls, so a
backpressured consumer continues counting against the two-per-stream and
eight-per-owner concurrency caps; every frame delivery separately revalidates
that lease and fails closed if it has disappeared or expired.

Cleanup runs every minute with fair per-class budgets — at most 4 cancellation
tombstones, 4 leases, and 2 purge gates per sweep, with the remaining document
budget always reserved for streams and chunks — deletes at most 16 documents
and 256 KiB per mutation, drains up to 20 batches, and reschedules itself
until the backlog is empty. Cleanup lag and failed sweeps are stored as
content-free operational diagnostics. Physical rows are normally removed
within minutes after logical expiry, but scheduler outages, backlog, recovery
systems, and provider-managed backups mean there is no absolute
physical-deletion guarantee.

Cancellation tombstones are quota-bounded (32 per owner, 4,096 service-wide)
and the `DELETE` endpoint is rate limited per owner, so cancellations cannot
become an unmetered write channel.

User data reset and account deletion first open a transactional owner purge
gate: while it is active, stream reservation, event appends, new tombstones,
and resume leases for that owner are refused, so in-flight relay work halts
and the drain cannot race with new plaintext. The drain then deletes the
owner's rows in bounded batches, runs a final pass after active work has been
rejected, and — for reset only — lifts the gate. Account deletion leaves the
gate in place for any still-valid tokens; the cleanup sweep removes it after
24 hours.

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
