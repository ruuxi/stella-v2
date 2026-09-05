# model-gateway

Cloudflare Worker in front of the model providers. It exchanges Better Auth
sign-ins for session capabilities, resolves model aliases, and relays model
requests on two lanes: the managed lane (Stella-billed, request/response,
priced and metered here) and the native lane (forwarded byte-for-byte with the
owner's connected subscription credential). Per-owner `OwnerRelayGate` Durable
Objects hold admission, enforcement state and managed cancellation; usage
events flow to Convex through `USAGE_QUEUE`.

## Routes

- `GET  /healthz`
- `POST /v1/capabilities/session`: Better Auth JWT plus device-key proof to a
  session capability.
- `POST /v1/models/resolve` and `POST /v1/models/prepare`: capability to a
  `GatewayModelResolution`. `/prepare` also waits for the owner object's
  pricing and enforcement reads; `/resolve` starts them in the background.
- `POST /v1/relay/*` and `POST /v2/relay/*`: capability to the managed or
  native lane. `/v2` requires the client's model descriptor revision and
  refuses a stale one before any accounting.
- `POST /internal/owners/enforcement`: service bearer pushes an owner's
  enforcement status to its owner object, mirrored to `OWNER_ENFORCEMENT` KV.

## Capability accounting

Capabilities without a signed `ledgerScope` keep their budget, request count
and replayable results in a `CapabilityLedger` object named by `jti`.
Cloud-builder capabilities carry `ledgerScope: "owner-relay-v2"`: their
requests execute inside the owner's `OwnerRelayGate`, where owner admission and
the capability reservation commit in one SQLite transaction. Ledger keys there
are the JSON tuple of generation and JTI; admission keys also include the
request id. Owner limits span generations while budgets, replies and refunds
stay capability-local. Never fall back between the two routes on an error:
that would create a second budget and replay authority.

Pricing comes from `GET /api/gateway/config` on Convex, cached per isolate for
`CONFIG_TTL_MS` with stale-while-revalidate. A cron publishes the complete
snapshot to `CONFIG_SNAPSHOT` KV, and owner objects keep the same record in
their own storage, so a cold owner serves warm pricing without a Convex call.

## Relay timing

`gateway_relay_timing` is emitted once when the relay handler finishes, including
awaited cleanup and error paths. Join it with other gateway logs using `traceId`
and with cloud-builder logs using the signed capability's `turnId` and
`conversationId`. Authentication failures have no turn identity. Credentials,
request bodies, response bodies and provider URLs are excluded. Requests
executed inside an owner object log `gateway_relay_route_timing` at the
forwarding worker and `gateway_relay_timing` with `execution: "owner"` at the
owner object.

`elapsedMs` and `milestonesMs` use the same request-local monotonic clock. Each
milestone is an offset from relay-handler entry, not a duration to add to the
other offsets. `durationsMs` measures named operations and records failed calls
as well as successful ones. Missing phases were not reached or did not apply;
they are not zero-duration measurements.

Milestones of a successful managed relay:

- `authenticated`: capability verification completed.
- `providerDispatch`: immediately before the upstream fetch. Authorization,
  routing, pricing and budget reservation all precede it.
- `providerDispatchReady`: durable writes were synced before dispatch when the
  request runs inside an owner object.
- `upstreamHeaders`: the upstream fetch returned response headers.
- `firstUpstreamByte`: first nonempty body chunk read, for SSE or JSON. This can
  contain protocol metadata, so it is not necessarily the first generated token.
- `upstreamBodyComplete`: the body reader reached EOF. Missing for a truncated,
  aborted or budget-stopped stream. Streaming parsing overlaps body reads.
- `assemblyComplete`: the complete provider object was assembled and serialized.
- `resultPersisted`: settlement of a completed result returned from the ledger.
  Ledger result-size rules still determine whether its body is replay-cacheable.
- `elapsedMs`: includes the later tier settlement and owner in-flight release.

Durations: `dpopMs`, `pricingConfigMs`, `ownerEnforcementMs`,
`ownerAdmissionMs`, `tierReservationMs`, `ledgerReservationMs` (or
`ownerReservationMs` for the combined owner admission and reservation),
`providerOutputGateMs`, `ledgerSettlementMs`, `tierSettlementMs` and
`ownerReleaseMs`.

The provider interval is `upstreamBodyComplete - providerDispatch`; it includes
network transport and stream consumption, not just inference. Post-body gateway
work is `elapsedMs - upstreamBodyComplete`. Native relays return a streaming
response, so their handler duration does not represent full response-body
completion; the `lane` field distinguishes them.
