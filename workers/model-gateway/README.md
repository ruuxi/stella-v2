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
