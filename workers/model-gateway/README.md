# Relay timing

`gateway_relay_timing` is emitted once when the relay handler finishes, including
awaited cleanup and error paths. Join it with other gateway logs using `traceId`
and with cloud-builder logs using the signed capability's `turnId` and
`conversationId`. Authentication failures have no turn identity. Credentials,
request bodies, response bodies and provider URLs are excluded.

`elapsedMs` and `milestonesMs` use the same request-local monotonic clock. Each
milestone is an offset from relay-handler entry, not a duration to add to the
other offsets. `durationsMs` measures named operations and records failed calls
as well as successful ones. Missing phases were not reached or did not apply;
they are not zero-duration measurements.

For a successful managed relay:

- `authenticated`: capability verification completed.
- `providerDispatch`: immediately before upstream fetch. Includes gateway
  authorization, routing, configuration and budget reservation before this point.
- `upstreamHeaders`: upstream fetch returned response headers.
- `firstUpstreamByte`: first nonempty body chunk read, for SSE or JSON. This can
  contain protocol metadata, so it is not necessarily the first generated token.
- `upstreamBodyComplete`: body reader reached EOF. Missing for a truncated,
  aborted or budget-stopped stream. Streaming parsing overlaps body reads.
- `assemblyComplete`: the complete provider object was assembled and serialized.
- `resultPersisted`: settlement of a completed result returned from the ledger.
  Ledger result-size rules still determine whether its body is replay-cacheable.
- `elapsedMs`: includes the later tier settlement and owner in-flight release.

The provider interval is `upstreamBodyComplete - providerDispatch`; it includes
network transport and stream consumption, not just inference. Post-body gateway
work is `elapsedMs - upstreamBodyComplete`. Use `ledgerReservationMs`,
`ledgerSettlementMs`, `tierReservationMs`, `tierSettlementMs`, `ownerAdmissionMs`,
`ownerReleaseMs`, `ownerEnforcementMs`, `dpopMs` and `pricingConfigMs` to isolate
individual operations.

Native relays return a streaming response, so their handler duration does not
represent full response-body completion. The `lane` field distinguishes them.
The older managed completion log precedes `finally` and excludes some cleanup;
it is neither pure provider time nor the full handler duration.

# Owner-scoped capability ledgers

New cloud-builder capabilities carry the signed `ledgerScope: "owner-v1"`
claim. They use `OWNER_CAPABILITY_LEDGER`, named by the JSON tuple of owner id
and owner generation. Capabilities without the marker keep using the original
`CAPABILITY_LEDGER` object named by `jti`. Never fall back between these routes
on an error: doing so would create a second budget and replay authority.

The new object stores one ledger row per `jti` and one result row per
`(jti, request_id)`. Budgets, request limits, reservations, charges, refunds and
cached replies remain capability-local. Sharing the object avoids creating a
new Durable Object for every turn; it does not pool users' or capabilities'
budgets. A new owner generation receives a different object.

Reserve and settle mutations run synchronously before their first await.
Ordinary output gates still require durable writes before replies. A shared
expiry alarm deletes only capabilities past their expiry plus the existing
result-cache retention window, then rearms for the next expiry. The legacy
class and its data are retained so issued capabilities can finish and replay.

Deploy gateway support and its additive SQLite class migration before deploying
the issuing cloud builder. To stop issuing the new route, remove the marker at
the issuer while retaining gateway routing support for already issued marked
capabilities. Do not roll the gateway back to code that ignores the marker:
that would send marked capabilities to a fresh legacy budget. The gateway's
phase event includes `ledgerScope` to distinguish the two paths during rollout.
