# Stella cloud apps

This document is the operating guide for Stella v2's cloud chat, agent turns,
model access, placement, app builder, hosting layer, standalone interior, and
mobile shell. The development stack described here is intentionally isolated
from Stella v1.

## Architecture

Two planes, one contract between them.

**Convex is the control plane.** It is the Better Auth issuer and the system of
record for accounts, Stripe and the billing ledger, plan definitions, the model
catalog and prices, the integrations catalog, projects and GitHub installs,
schedules, memory and skills metadata, prompts, drive metadata, releases, and
the conversation index plus recall search. Every reactive query the UI
subscribes to is a Convex query. Development deployment `outgoing-bulldog-865`;
production `intent-jackal-330`.

**Cloudflare is the data plane.** Three Workers carry everything a turn or a
model request touches:

| Worker                       | Owns                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `stella-v2-model-gateway-dev` | All model access: capability verification, provider keys, budget ledger, usage events.   |
| `stella-v2-cloud-builder-dev` | The turn plane: turn admission, conversation transcripts, agent sandboxes, placement.    |
| `stella-v2-apps-host-dev`     | App and interior hosting (with `stella-v2-interior-dev` on the same code).               |

`stella-v2-cloud-builder-dev` runs four Durable Object classes on the turn
path:

- **`OrchestratorSession`** — one per conversation. Owns the journal (the
  canonical ordered transcript), admits chat turns, runs the delegation-only
  orchestrator loop, and mints the turn's capabilities.
- **`BuildSession`** — one per agent thread or app build. Owns sandbox turns,
  the thread transcript, and the checkpoint lifecycle.
- **`OwnerGate`** — one per owner. Holds the cached owner snapshot, quota
  windows, the running-turn registry, device presence sockets, and dispatch
  placement. It also hosts the owner's purge fence and owner turn-state
  authority.
- **`CapabilityLedger`** — in the gateway Worker, one per capability `jti`;
  budget and request accounting plus the replayable result cache.

### Invariants

No synchronous Convex call sits on a turn's admission path or on a model
request: the one control-plane read a turn depends on is the owner snapshot,
which the `OwnerGate` caches and Convex pushes a fresh copy of on change; the
gate serves its copy without waiting on Convex and refreshes in the background
(stale-while-revalidate). Authorization travels as signed ES256 capability
JWTs rather than per-request lookups — Convex mints `session` capabilities
(issuer `stella-convex`), and a Durable Object mints two `turn` capabilities per
admitted turn (issuer `stella-cloud-builder`), one for the model gateway
(audience `stella-model-gateway`, may enter a sandbox or a CLI) and one for
Convex callbacks (audience `stella-control-plane`, never leaves the object).
Every write from the data plane back to Convex goes through one outbox queue,
idempotent by `(kind, key)`, at-least-once and possibly reordered, so
projections are fenced or keyed and never append-only. Stella-owned model calls
are request/response: the gateway consumes the provider's stream internally and
returns one complete provider-native JSON object, and `stream: true` in a
managed body is refused. SSE survives in exactly three places — inside the
gateway's provider adapter, the native byte pipe for the Claude Code and Codex
CLIs, and the realtime voice/dictation paths. The conversation socket carries
committed journal records, never token deltas.

## Model gateway

`workers/model-gateway`. Callers point their vendor SDK at
`baseUrl = <gatewayOrigin>/v1/relay` and send
`Authorization: Bearer <capability>`.

### Routes

| Method | Path                           | Auth                     | Result                                                     |
| ------ | ------------------------------ | ------------------------ | ---------------------------------------------------------- |
| GET    | `/healthz`                     | none                     | `{ok:true}`                                                |
| POST   | `/v1/capabilities/session`     | Better Auth JWT          | `GatewaySessionCapabilityResponse` from Convex             |
| POST   | `/v1/models/resolve`           | capability or probe      | resolution for the capability's audience                  |
| POST   | `/v1/relay/*`                  | capability or probe      | managed lane, or native lane with `credential`            |
| POST   | `/internal/owners/enforcement` | `GATEWAY_SERVICE_SECRET` | store or clear an owner's enforcement status in gateway KV |

Anything else is `404 bad_request`; a wrong method is `405 bad_request`. The
relay suffix selects the protocol:

| Relay path                                                        | Protocol               |
| ----------------------------------------------------------------- | ---------------------- |
| `/v1/relay/v1/messages`                                            | `anthropic-messages`   |
| `/v1/relay/responses`                                              | `openai-responses`     |
| `/v1/relay/chat/completions`                                       | `openai-completions`   |
| `/v1/relay/models/{model}:generateContent` or `:streamGenerateContent` | `google-generative-ai` |

Headers:

| Header                          | Meaning                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `authorization`                 | `Bearer <capability>`.                                                       |
| `x-stella-agent-type`           | Required on the managed lane; checked against the capability's `agentTypes`. |
| `x-stella-request-id`           | Caller-minted idempotency key; the gateway mints a UUID when absent.         |
| `x-stella-gateway-trace`        | Echoed on every response so both sides' logs join.                           |
| `x-stella-gateway-replay`       | `1` when the body came from the ledger's result cache.                        |
| `x-stella-relay-probe-secret`   | Ops probe; grants a synthetic `pro` session capability, never metered.        |

### Managed lane

Stella-billed, request/response. Admission runs in this order before the gateway
reads a provider byte: verify the capability; read `OWNER_ENFORCEMENT`; apply
`ANON_IP_LIMITER` and `NetworkGate` for anonymous callers, or `NetworkGate` for
Free; call `OwnerRelayGate.admitRelay`; reserve the audience's `TierBudget`
when the config snapshot defines a finite ceiling; reserve the
`CapabilityLedger`; call the provider. Probes and unlimited capabilities skip
the tier budget. A `finally` block settles every acquired budget reservation and
releases owner concurrency on validation errors, provider failures, client
aborts, and successful responses.

After owner admission, the gateway validates agent type, body, cloud binding,
route, protocol, and reasoning binding. It clamps the provider's output-token
field to the audience and model ceilings, prices the capped request, and forces
upstream streaming. While consuming SSE it tracks the input estimate plus output
cost. If a finite capability crosses its remaining budget, the gateway cancels
the provider stream, settles the partial charge, and returns
`402 budget_exhausted` with capability quota metadata.

Limits: request body ≤ 24 MB, upstream stream ≤ 64 MB, upstream idle timeout
5 min, absolute duration ceiling 45 min, result cache ≤ 8 MB kept for 10 min.
A provider `401`/`403` is the gateway's own credential problem and is translated
to `502 upstream_error`; other non-2xx statuses are returned as-is with a
redacted body. A client abort settles as `aborted`. A failure or abort before
the first provider byte refunds the capability request count. Failures after the
first byte keep that count.

### Edge placement and zone rules (ops)

Put the model-gateway and cloud-builder public HTTP endpoints on custom domains
in the Stella Cloudflare zone. This makes the zone's WAF, bot rules, and rate
limits apply before either Worker runs. Keep `workers.dev` enabled for probes,
but configure clients and Convex with the custom origins. Add routes like these
to the matching development and production environment blocks only after ops
has created the DNS names:

```jsonc
// workers/model-gateway/wrangler.jsonc
// "routes": [
//   { "pattern": "gateway.REPLACE_ME_STELLA_ZONE", "custom_domain": true },
// ],

// workers/cloud-builder/wrangler.jsonc
// "routes": [
//   { "pattern": "cloud.REPLACE_ME_STELLA_ZONE", "custom_domain": true },
// ],
```

Give the Convex `.convex.site` HTTP router a Convex custom domain in the same
Stella zone, and keep that DNS record proxied through Cloudflare. Point
`STELLA_CONVEX_SITE_URL` at this custom HTTPS origin after Convex verifies it.
The sync client's WebSocket URL stays on `.convex.cloud`; do not proxy or
rewrite that WebSocket through the HTTP-router domain.

Enable these controls in the Cloudflare dashboard for the Stella zone:

- Bot Fight Mode.
- A rate-limiting rule whose path is exactly
  `/api/auth/sign-in/anonymous`. Pick the request window and threshold from
  observed sign-in traffic, and block excess requests at the edge.
- When the zone has Bot Management, a managed-challenge rule for the HTTP auth
  paths. Exclude provider callbacks that cannot complete an interactive
  challenge.

Both Workers bind the same `ASN_POLICY` KV namespace for an environment. Create
one namespace for development and one for production, copy each returned id
into both `wrangler.jsonc` files, and use a separate namespace for an isolated
preview when needed:

```sh
cd workers/model-gateway
bunx wrangler kv namespace create ASN_POLICY --env=""
bunx wrangler kv namespace create ASN_POLICY --env=production
```

An override key is the decimal ASN number, such as `16509`. Its value must be
one of `hosting`, `vpn`, `residential`, `mobile`, `edu`, or `unknown`. Workers
read overrides with a 300-second KV cache. Missing, invalid, or unavailable
overrides fall back to the built-in policy.

Classification checks the KV override first, then exact ASN tables, then the
lowercased Cloudflare `asOrganization` value. A request without a Cloudflare
ASN is `unknown`, even if it has an organization string.

| Class | Built-in signals | Edge policy |
| ----- | ---------------- | ----------- |
| `hosting` | AWS `16509`, `14618`, `8987`; Google `15169`, `396982`; Azure `8075`; DigitalOcean `14061`; Hetzner `24940`; OVH `16276`; Linode/Akamai `63949`; Vultr/Choopa `20473`; Oracle `31898`; Alibaba `45102`, `45090`; Tencent `132203`; Leaseweb `60781`; M247 `9009`; Datacamp `212238`; Contabo `51167`; Scaleway `12876`; IONOS `8560`; Fly.io `40509`. Organization strings also match `hosting`, `datacenter`, `data center`, `cloud`, `server`, `colocation`, `vps`, and `dedicated`. | Anonymous mint, relay, turn start, and dispatch return `403 sign_in_required`. Free mint passes the class to Convex for a Turnstile step-up, and Free relay uses half the normal `NetworkGate` caps. |
| `vpn` | Cloudflare `13335` for WARP and iCloud Private Relay egress. Organization strings match Mullvad, NordVPN, ExpressVPN, Private Internet Access, Proton, Surfshark, TunnelBear, Windscribe, IPVanish, CyberGhost, hide.me, and ZenMate. | Anonymous traffic returns `403 sign_in_required`. |
| `mobile` | Organization strings match `mobile`, `wireless`, `cellular`, T-Mobile, Verizon Wireless, Vodafone, Orange, Telefonica, and AT&T Mobility. | Normal tier policy. |
| `edu` | Organization strings match `university`, `college`, `school`, or `edu`. | Normal tier policy. |
| `residential` | A known ASN with no table or organization match. | Normal tier policy. |
| `unknown` | No valid ASN. | Normal tier policy. |

Go, Pro, and other paid audiences are not restricted by the network class.

### Native lane

Selected when the capability carries `credential` (`anthropic` or
`openai-codex`). It must be a `turn` capability whose `execution.engine` matches
the credential. The connected-binding validator pins the model, path, and body;
the owner's OAuth credential comes from `POST /api/gateway/engine-access`,
cached per `(ownerId, generation, provider)` until `expiresAt - 60 s` and at most
5 min. Request bytes go upstream untouched apart from credentials, response
bytes (JSON or SSE) come back untouched with the upstream status and an
allowlisted header set (`content-type`, `retry-after`, `request-id`,
`x-request-id`, `anthropic-request-id`, `openai-processing-ms`). Nothing here is
billed: the usage event carries `chargedMicroCents: 0` and `billable: false`, and
usage is parsed best-effort off the response path from a JSON body ≤ 4 MB.

### Capability claims

| Claim              | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `iss`              | `stella-convex` (session) or `stella-cloud-builder` (turn).                 |
| `aud`              | `stella-model-gateway` or `stella-control-plane`.                           |
| `sub`              | Owner id (`${issuer}\|${subject}` token-identifier form).                   |
| `jti`              | Capability id; the budget ledger is keyed on it.                            |
| `gen`              | Owner data generation; a stale generation is refused.                       |
| `kind`             | `session` or `turn`.                                                        |
| `audience`         | Managed model audience: `anonymous`, `free`, `go`, `pro`, `*_fallback`.     |
| `agentTypes`       | Agent types this capability may act as; absent means any.                   |
| `budgetMicroCents` | Lifetime spend ceiling, or `-1` for unlimited.                              |
| `maxRequests`      | Request-count ceiling (anonymous trials); absent means unlimited.           |
| `turn`             | `{turnId, conversationId, execution}` on turn capabilities.                 |
| `credential`       | Native lane engine, when the turn runs on the owner's subscription.         |

TTLs: session capability 1 h, turn capability 30 min, 60 s of clock skew
tolerated. Convex reserves a small owner allowance chunk at mint and places it
in the capability: $0.10 anonymous, $1 Free, $2 Go, or $5 Pro. Anonymous
capabilities also carry a 10-request chunk. Anonymous minting is keyed by owner
and the gateway's IP hash. Client-provided device identifiers are not accepted.

### Ledger and budgets

`CAPABILITY_LEDGER` is one SQLite Durable Object per `jti`. `reserve` refuses
with `request_limit` when `requests >= max_requests` and with `budget_exhausted`
when `spent + reserved + estimate > budget` (an unlimited budget never refuses
on money); a settled request id replays its stored result instead of reserving;
an in-flight id returns `in_flight` (surfaced as `409`, retryable). `settle`
releases the reservation, adds the charge to `spent`, optionally refunds the
request count when no provider byte arrived, and stores the body for replay when
it fits the cache ceiling. A reservation with no
settlement after 45 min + 60 s belonged to a dead isolate and is released on the
next reserve for the same request id. An alarm at `exp + 10 min` deletes
everything. No Convex call is ever on this path.

`OWNER_RELAY_GATE` is one SQLite `OwnerRelayGate` per owner. It enforces rolling
per-minute relay velocity, per-hour mint velocity, and in-flight relay limits.
Enforcement status `throttled` halves these limits, rounded down with a minimum
of one. `NETWORK_GATE` is one SQLite `NetworkGate` per IP hash. Anonymous
traffic has hourly and daily relay counters plus a daily mint counter. Free has
a daily relay counter. Go and Pro do not use network counters.

`TIER_BUDGET` is one SQLite `TierBudget` per base audience. Each call receives
the current hourly and daily ceilings from the cached Convex config snapshot.
The object stores per-minute reserved or settled micro-cents, not config. A
breaker trip logs at error level and may post to `ALERT_WEBHOOK_URL`. Webhook
posts are limited to one per audience and window every five minutes.

`OWNER_ENFORCEMENT` stores `{status, until?, updatedAt}` by owner id. Mint and
managed relay reads use a 60-second KV cache. `suspended` returns
`403 owner_suspended`; `throttled` reduces owner gate limits. Convex pushes this
route directly to KV, so an enforcement push never creates a Durable Object.

### Error codes

| Code                  | Status  | Cause                                                     |
| --------------------- | ------- | --------------------------------------------------------- |
| `unauthorized`        | 401/403 | No bearer, or Convex refused a session capability.         |
| `capability_expired`  | 401     | `exp` passed.                                              |
| `capability_invalid`  | 401     | Bad signature, unknown key, wrong issuer/audience, malformed. |
| `generation_stale`    | 403     | Capability's `gen` is not the owner's current generation.   |
| `agent_type_forbidden`| 403     | `x-stella-agent-type` outside the capability's list.        |
| `execution_mismatch`  | 403     | Model, engine, or reasoning does not match `turn.execution`. |
| `stream_unsupported`  | 400     | `stream: true` on the managed lane.                         |
| `bad_request`         | 400/404/405/409 | Shape, unknown path, wrong method, request in flight. |
| `budget_exhausted`    | 402     | Capability budget spent.                                    |
| `request_limit`       | 429     | Anonymous request ceiling reached.                          |
| `rate_limited`        | 429     | Owner or network velocity limit reached.                    |
| `concurrency_limit`   | 429     | Owner in-flight relay limit reached.                        |
| `sign_in_required`    | 403     | Anonymous tier breaker requires a signed-in account.        |
| `tier_paused`         | 429     | The audience hourly or daily spend breaker tripped.         |
| `owner_suspended`     | 403     | Owner enforcement status is suspended.                      |
| `upstream_error`      | 502     | Provider refused, or the stream could not be assembled.     |
| `upstream_timeout`    | 504     | Idle or duration ceiling hit.                               |
| `canceled`            | 499     | Caller aborted.                                             |
| `internal`            | 500/503 | Unconfigured provider, key, or Convex unavailable.          |

Admission refusals include `error.quota.scope`. When the gate knows when its
rolling window clears, the body also includes `resetAt` and `retryAfterMs`, and
the response carries the matching `retry-after` header.

### Usage queue

The gateway produces and consumes `stella-v2-gateway-usage-dev` in the same
Worker (batch 50, 5 s timeout, 5 retries, dead-letter
`stella-v2-gateway-usage-dlq-dev`). One batch becomes one
`POST /api/gateway/usage` to Convex. A 2xx acks the batch — per-event duplicates
and rejections are reported in the body and logged, never retried, because the
batch is idempotent on `requestId`. A 5xx, timeout, or unreachable Convex retries
the whole batch on a 5/15/60/180/600 s ladder. Any other 4xx is logged and
acked so a bad batch cannot poison the queue. Convex writes the billing usage
windows, credits, usage logs, and anonymous counters, deduplicating on
`gateway_usage_receipts`.

### Minting capability keys

One ES256 key pair per issuer:

```sh
bun scripts/generate-capability-keys.mjs convex-1   # or builder-1
```

The kid prefix picks the issuer (`convex*` → `stella-convex`, `builder*` →
`stella-cloud-builder`). The script prints the PKCS8 private PEM — set it as
that issuer's `CAPABILITY_SIGNING_KEY` through a pipe, never a command
argument — the kid, and the public JWKS entry.

`CAPABILITY_JWKS` is a JSON `GatewayJwks` document holding the **public** keys of
both issuers:

```json
{
  "keys": [
    { "kid": "convex-1", "issuer": "stella-convex", "jwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } },
    { "kid": "builder-1", "issuer": "stella-cloud-builder", "jwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } }
  ]
}
```

The gateway imports it once per isolate and never fetches keys over the network:
an empty or malformed key set rejects every capability, so the Worker fails
closed. Convex holds the same document in its own `CAPABILITY_JWKS` env var to
verify control-plane capabilities on callback routes. Rotate by publishing the
new public entry to both verifiers first, then switching the issuer's key and
kid; capabilities expire within an hour, so the old entry can be dropped after
that.

## Turn plane

### `POST /conversations/:conversationId/turns`

The cloud-builder Worker is the turn gateway; its public origin is already the
`socketOrigin` clients receive. Two authentications open this route:

| Auth kind | Credential                                                        | Callers                                                       |
| --------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `user`    | `Authorization: Bearer <Better Auth JWT>`                          | desktop, web shell, mobile                                     |
| `service` | `Bearer <BUILDER_SERVICE_SECRET>` + `x-stella-owner-id` + `x-stella-owner-generation` | schedules, placement's cloud branch, agent-completion wakes |

The Worker verifies the caller, refuses shape errors and service-only fields,
then forwards to `ORCHESTRATOR_SESSIONS.getByName(conversationId)` with a
header set built from scratch: `x-stella-owner`, `x-stella-turn-auth`,
`x-stella-conversation-id`, plus `x-stella-owner-generation` (service callers)
or `x-stella-token-exp` (user callers). Nothing of the caller's headers reaches
the object, and the body cannot name an owner at all.

Body (`CloudTurnStartRequest`): `protocol: 1`, `clientMsgId` (8–64 URL-safe
characters), `prompt` (≤ 8000 characters), and optionally `execution`, `locale`,
`attachments` (≤ 4 drive paths), `lane`, `source`, `title` (≤ 120 characters).
`lane` other than `chat`, a `source` outside `desktop`/`web`/`mobile`,
`hiddenMessage`, and `agentThreadControl` are service-only; a user-authenticated
request that sets one is refused with `403 forbidden` naming the field.
Anonymous Better Auth owners may use the `chat` lane. They cannot start or
dispatch agent-lane work or app builds; those requests answer
`403 sign_in_required` until the owner signs in.
Conversation ids are client-minted and must match 8–128 URL-safe characters.

Success is `202` with
`{protocol, conversationId, turnId, accepted: true, replayed, createdConversation}`.

| Error code             | Status |
| ---------------------- | ------ |
| `unauthorized`         | 401    |
| `forbidden`            | 403    |
| `owner_mismatch`       | 403    |
| `generation_stale`     | 403    |
| `bad_request`          | 400    |
| `conversation_locked`  | 423    |
| `idempotency_conflict` | 409    |
| `quota_burst`          | 429    |
| `quota_daily`          | 429    |
| `quota_concurrency`    | 429    |
| `owner_purged`         | 410    |
| `execution_unavailable`| 409    |
| `sign_in_required`     | 403    |
| `owner_suspended`      | 403    |
| `internal`             | 503    |

Refusals carry `{error: {code, message, retryable, retryAfterMs?}}` and a
`retry-after` header when a retry delay is known.

### Durable Object admission

`OrchestratorSession` decides everything, in this order, under a single
admission lock:

1. **Identity.** Trusted headers only; a service caller must also pin an owner
   generation.
2. **Shape and service-only fields**, repeated here because the object trusts
   nothing it did not check itself; `wake` turns must carry
   `agentThreadControl` and no other lane may.
3. **Purge check**, then **owner binding** — a conversation already bound to
   another account is `owner_mismatch`.
4. **Idempotency.** A durable receipt keyed by `clientMsgId` stores a
   fingerprint of the request. Same fingerprint and phase `accepted` replays the
   original `202` with `replayed: true`; a different fingerprint is
   `idempotency_conflict`; a receipt still in `registering` resumes that exact
   identity instead of minting a second turn id or fence lease.
5. **Owner gate.** `OwnerGate.admit({lane, turnId, conversationId, expectedGeneration?, quota})`.
   A `wake` turn admits with `quota: "bypass"` — it occupies a running slot so
   concurrency stays truthful but does not consume the user's burst or daily
   window.
6. **Execution.** `start.execution ?? snapshot.execution`; an engine the owner
   has no live connected credential for is `execution_unavailable`.
7. **Adoption.** The first verified caller binds the owner, the created-at, and
   the title (derived from the prompt when no `title` hint was sent).
8. **Durable admission intent**, then the owner-purge fence registration.
9. **Commit.** `blockConcurrencyWhile` writes the queued turn, flips the receipt
   to `accepted`, records the owner generation, and arms the watchdog alarm
   together. An active conversation edit lock refuses with
   `conversation_locked`.
10. **Projections.** `conversation.created` (when this turn created the
    conversation) and `turn.started` go to the outbox before the `202`, so Convex
    learns of both no matter what the isolate does next.
11. **`202`**, and the turn runs detached.

Capabilities are minted when the turn actually starts, before any callback:
`mintTurnCapabilities` signs both audiences from the same binding
(`ownerId`, `ownerGeneration`, `turnId`, `conversationId`, `execution`,
`audience`, `budgetMicroCents`, `agentTypes: ["orchestrator"]`). The
control-plane token is the bearer for every synchronous Convex route the turn
touches; the model token is the only credential the gateway ever sees.

### Owner gate

One `OwnerGate` per owner (binding `OWNER_GATES`, object name = `ownerId`).

- **Snapshot.** `GET {convex}/api/gateway/owner-snapshot?ownerId=` with
  `BUILDER_SERVICE_SECRET`. It carries the owner generation, a write fence
  (`writable`), anonymous-owner and enforcement status, the plan and
  `unlimited` flag, per-lane quotas, the model
  allowance (audience, budget, request ceiling), the owner's default execution,
  connected engines, execution devices with their public keys, and paired mobile
  devices. The gate serves any cached copy younger than three `ttlMs` (300 s
  each) immediately; a copy past one ttl, or one marked stale by a push, starts a
  single shared background refresh while the turn proceeds. Only a gate with no
  copy at all, or one beyond the three-ttl ceiling, fetches synchronously, with a
  3 s timeout, and then fails closed as `internal`, retryable. Background
  refreshes have a 10 s timeout because admission does not wait for them. A
  definite "owner gone" is never papered over by the cache: a background
  refresh that learns it removes the copy it started from. This is what keeps
  Convex off the turn path; the earlier design blocked admission on a 10 s fetch
  whenever the ttl expired or a push landed, which showed up as 8–18 s stalls in
  production logs.
- **Push.** Convex posts
  `POST {builder}/internal/owners/snapshot-changed` (service secret) with a
  reason of `billing`, `generation`, `engine`, `pairing`, `device`, or `manual`
  and, normally, the freshly computed `snapshot` itself, which replaces the
  gate's copy (an older `fetchedAt` never overwrites a newer one). A push that
  could not compute the snapshot carries no `snapshot` and only marks the copy
  stale. The generation push at owner creation pre-warms the gate before an
  owner's first turn. The TTL is the backstop when a push is lost.
- **Windows.** Rolling starts per lane: burst over 10 minutes, daily over
  24 hours, both from `snapshot.quotas[lane]`. An `unlimited` owner skips them.
  A refusal computes exactly when a slot frees and returns it as `retryAfterMs`.
- **Anonymous and suspended owners.** Anonymous snapshots can enter only the
  chat lane. Agent admission returns `sign_in_required`, including quota-bypass
  work. A suspended enforcement snapshot refuses every lane and dispatch with
  `owner_suspended`; other non-writable snapshots remain `owner_purged`.
- **Concurrency.** A `running` registry per lane, plus one running agent per
  workspace on the agent lane. A row whose release never arrives is presumed
  released after `TURN_TIMEOUT_MS` (900 s) plus a 60 s grace, so a lost isolate
  cannot wedge an owner. Concurrency retry hints are clamped to 1–30 s.
- **Refusals are values, not exceptions**: `quota_burst`, `quota_daily`,
  `quota_concurrency`, `sign_in_required`, `owner_suspended`, `owner_purged`,
  `generation_stale`, `internal` map
  straight onto the turn-start contract.
- **Release** is idempotent; every terminal path and every failed dispatch
  releases.
- **Owner fence.** `POST /owner-fence/*` reaches the fence in this same
  owner-named object. The fence keeps `ownerPurgeFence`, `owner_fence_*`, and
  `turn-state:v1:*` beside the gate instead of waking an `owner-purge-*`
  `BuildSession`. The single object alarm expires both gate dispatch/presence
  deadlines and fence leases, then re-arms at the earlier remaining deadline.

### Agent turns

`POST /sessions/:threadId/turns` is service-authenticated only
(`BUILDER_SERVICE_SECRET`). Convex uses it for desktop-dispatched cloud agents,
placement's agent branch, and hosted-browser resumes. Identity is in the body
(`CloudAgentTurnStartRequest`: owner, generation, conversation, thread,
`attemptGeneration`, optional pinned `turnId`, prompt, description, execution,
audience, budget, source), because both callers are already inside the service
boundary; the Worker proves that with the shared secret before forwarding, and
the `BuildSession` re-parses everything.

The orchestrator's own spawns never pass through Convex or that route. The
`OrchestratorSession` admits on the owner gate itself (lane `agent`, workspace
pinned), then calls `env.BUILD_SESSIONS.getByName(threadId).fetch(".../turn")`
directly with `x-stella-gate-admitted: 1` so the session does not admit a second
time, and releases the gate on every failure path. A `thread.spawned` event
projects the row.

The thread transcript lives in the `BuildSession`'s own SQLite
(`thread_messages`, ordered by insertion; `turn_counters` for the per-attempt
event sequence and append batch ordinal). A continuation reads its own history
with no control-plane round trip. Nothing projects those rows to Convex: the
UI reads local runtime threads, and a thread transcript exists for the agent that
owns it. The same FTS5 index the conversation journal uses is mounted on
`thread_messages` (`thread_fts`, see `transcript-search.ts`) so a thread could be
given Recall later without a redesign.

Completion wakes the parent conversation directly — the one delivery a
projection cannot do, because the parent needs a turn, not a row. The
`BuildSession` posts to the parent `OrchestratorSession`'s `/turn` with lane
`wake`, `hiddenMessage: true`, `source: "agent-thread"`, the agent's report as
the prompt, an `agentThreadControl` receipt, and a `clientMsgId` of
`wake:<threadId>:<attemptGeneration>` — so a redelivery is admitted as a replay
rather than refused. Desktop-origin threads are skipped: the originating device
consumes the Convex projection instead, and waking here as well would put the
same report in two orchestrators.

### Outbox

Durable Objects append to the `TURN_OUTBOX` queue (`stella-v2-turn-outbox-dev`,
batch 50, 2 s timeout, 10 retries, dead-letter `stella-v2-turn-outbox-dlq-dev`).
The consumer in the same Worker posts each batch to
`POST {convex}/api/cloud/outbox` with `BUILDER_SERVICE_SECRET`.

| Kind                       | Idempotency key                                                | Projection                                        |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `conversation.created`     | `conversationId`                                                | `cloud_conversations` row                          |
| `conversation.index`       | `${conversationId}:${epoch}:${lastSeq}:${updatedAt}`            | index row (title, preview, activity), fenced on `(epoch, lastSeq)` |
| `conversation.deleted`     | `conversationId`                                                | tombstone                                          |
| `turn.started`             | `turnId`                                                        | `agent_turns` row                                  |
| `turn.event`               | chat `${turnId}:${eventSeq}`; agent `${turnId}:${attemptGeneration}:${eventSeq}` | `agent_events`               |
| `thread.spawned`           | `${threadId}:${attemptGeneration}`                              | `cloud_agent_threads` row                          |
| `thread.completed`         | `${threadId}:${turnId}:${attemptGeneration}`                    | thread terminal state                              |
| `build.recorded`           | `buildId`                                                       | `cloud_app_builds` candidate                       |
| `interior-build.recorded`  | `buildId`                                                       | interior candidate                                 |
| `dispatch.updated`         | `${dispatchId}:${revision}`                                     | `cloud_dispatches` activity projection             |

Convex applies one mutation per event: a receipt in `cloud_outbox_receipts` keyed
`(kind, key)` short-circuits duplicates, the owner fence runs before any
projection is touched, and the reply names each event `applied`, `duplicate`, or
`rejected` with a reason (`owner_purged`, `owner_mismatch`, `generation_stale`,
`stale_epoch`, `stale`, `unknown_turn`, `unknown_thread`, `invalid`). Rejections
are permanent by contract.

The consumer's only job is the transport verdict: 2xx acks (rejections logged);
5xx, 408, 429, timeout, or a network failure retries the whole batch; any other
4xx is a contract mismatch, logged and acked so it cannot block the queue; a
2xx without a parseable verdict is treated as undelivered. A missing Convex URL
or secret retries in 30 s rather than dropping projections.

### What Convex still serves synchronously

These are control-plane reads and writes a running turn makes on purpose. None
of them is on the admission path or a model request.

| Route                                                             | Auth                                        |
| ----------------------------------------------------------------- | ------------------------------------------- |
| `POST /api/cloud/web-search`                                       | control-plane capability                     |
| `POST /api/cloud/schedule`                                         | control-plane capability                     |
| `POST /api/cloud/drive/attachments`, `/drive/sync`, `/drive/files` | control-plane capability (`/drive/files` also accepts the service secret) |
| `GET`/`POST /api/cloud/integrations/mcp`                           | control-plane capability                     |
| `POST /api/cloud/home/memory/*`, `/home/skills/*`                  | control-plane capability, or service secret when the Worker's own cloud-home routes call on a user's behalf |
| `POST /api/cloud/home/access`                                      | `BUILDER_SERVICE_SECRET`                     |
| `POST /api/cloud/agent-home/register`                              | `BUILDER_SERVICE_SECRET`                     |
| `POST /api/cloud/model`                                            | `BUILDER_SERVICE_SECRET`                     |
| `GET /api/cloud/interior-active-route`                             | `BUILDER_SERVICE_SECRET`                     |
| `POST /api/cloud/outbox`                                           | `BUILDER_SERVICE_SECRET`                     |
| `GET /api/gateway/owner-snapshot`                                  | `BUILDER_SERVICE_SECRET`                     |
| `POST /api/gateway/session-capability`                             | `GATEWAY_SERVICE_SECRET`                     |
| `POST /api/gateway/usage`                                          | `GATEWAY_SERVICE_SECRET`                     |
| `GET /api/gateway/config`                                          | `GATEWAY_SERVICE_SECRET`                     |
| `POST /api/gateway/engine-access`                                  | `GATEWAY_SERVICE_SECRET`                     |

A control-plane capability is verified against `CAPABILITY_JWKS` with issuer
`stella-cloud-builder` and audience `stella-control-plane`, must be `kind:
"turn"`, and its `gen` must equal the owner's current generation (else `409`).
The model-gateway audience is refused here, so a capability that entered a
sandbox can never reach the control plane.

## Placement and presence

**Stage 3, as contracted; verify against
`workers/cloud-builder/src/owner-gate.ts`.** The contract is
`packages/contracts/turn-plane/placement.ts`.

A dispatch is "run this prompt somewhere": on the owner's desktop when one is
present and capable, else in Stella's cloud. The `OwnerGate` owns the dispatch
row, the device presence sockets, the offer window, the claim/ack handoff, and
the cloud fallback. Convex keeps only a projection for the activity UI, fed by
`dispatch.updated` outbox events.

| Method | Path                                        | Auth                                   |
| ------ | ------------------------------------------- | -------------------------------------- |
| POST   | `/owners/me/dispatches`                     | user JWT, service secret + owner headers, or a user JWT carrying mobile pairing-proof headers |
| GET    | `/owners/me/dispatches/:dispatchId`         | user JWT / service                     |
| POST   | `/owners/me/dispatches/:dispatchId/cancel`  | user JWT / service                     |
| GET    | `/owners/me/devices`                        | user JWT                               |
| GET    | `/owners/me/devices/:deviceId/presence`     | user JWT (WebSocket upgrade)           |

Timings, unchanged from the Convex implementation they replace: offer window
4 s, claim lease 30 s, accepted lease 120 s, payload TTL 15 min, presence ping
10 s, presence stale after 60 s.

Dispatch states: `offering`, `computer_claimed`, `computer_accepted`,
`computer_running`, `cloud_committed`, `cloud_running`, `cancel_pending`,
`reconciliation_required`, `blocked`, `completed`, `failed`, `canceled` — the
last four terminal.

The presence socket speaks subprotocol `stella.v1` with frames ≤ 64 KB. The
server sends `challenge`, `connected`, `offer`, `offer.withdrawn`, `claimed`,
`cancel`, `dispatch`, `pong`, `error`; the device sends `begin`, `proof`,
`availability`, `claim`, `release`, `ack`, `running`, `renew`, `complete`,
`ping`. The `proof` frame is an Ed25519 signature over
`stella-device-presence\0${connectionId}\0${nonce}`, verified against the device
public key the owner snapshot carries in `devices[]` — the JWT proves the
account, the proof proves the device. Close codes: `4001` replaced, `4002`
stale, `4403` proof rejected, `4401` unauthorized, `4000` protocol, `4500`
internal.

The payload is handed to the device on `claim` and deleted on `ack`, so the
desktop's local inbox becomes the only copy. If no eligible device claims inside
the offer window, the gate runs the cloud branch itself: `OrchestratorSession`
`/turn` for a chat dispatch, `BuildSession` `/turn` for an agent dispatch.

Mobile submits carry the pairing-proof headers the app already sends. The Worker
verifies them against the snapshot's `pairedDevices[]` — `mobilePublicKey` is
the HMAC-SHA256 key, `sha256hex(pairSecret)`, the same `pairSecretHash` Convex
stores on the grant — and forwards with `ingress: "mobile"` without a Convex
round trip.

## Plan and abuse controls

The owner snapshot carries the plan's per-lane quotas; the `OwnerGate` enforces
them. Chat and agent lanes currently draw the same numbers.

| Plan                | Turns / rolling 24 h | Concurrent turns | Starts / 10 min |
| ------------------- | -------------------: | ---------------: | --------------: |
| Free                |                    3 |                1 |               4 |
| Go                  |                   10 |                1 |               6 |
| Pro                 |                   25 |                2 |              10 |
| `unlimited` usage mode |               200 |                6 |              40 |

These are the shipping guardrails for the development phase. Product/finance
must confirm the plan-to-quota mapping before production cutover. Changes belong
in `CLOUD_PLAN_QUOTAS` / `UNLIMITED_CLOUD_QUOTA` in `convex/cloud_apps.ts`, which
`owner_snapshot.ts` serves to the gate.

`POST /conversations/:id/journal` is the one live user-authenticated write path
that is **not** a turn, so none of the above reaches it: it mirrors a desktop
transcript into a cloud conversation without ever running the loop. It is bound
in the Durable Object instead, where the storage actually is and where the check
costs nothing:

- a fixed append window per conversation — `APPEND_WINDOW_MAX_REQUESTS` /
  `APPEND_WINDOW_MAX_BYTES` per `APPEND_WINDOW_MS`, answered `429` with
  `retryAfterMs`, and charged only when rows are actually committed so a `409`
  against a running turn does not eat the client's allowance;
- a lifetime ceiling, `CONVERSATION_MAX_STORED_BYTES`, measured over resident
  rows **plus** committed segments so rolling bytes into R2 does not reset it,
  answered `413 conversation_full`;
- rollover on the route itself, so a conversation written only through this
  route (or `/cards`) still evaluates `HOT_MAX_ROWS`.

All three live in `workers/cloud-builder/src/conversation-types.ts`. Making the
ceiling a per-plan number is the open product decision — the enforcement point
is one constant, but what Free may mirror is not an engineering call.

## Environment and secrets

Cloudflare, R2, model, signing, and builder credentials live only in the v2
Convex environment or encrypted Worker secrets. Retrieve values into a pipe,
stdin, or an ephemeral environment variable; never echo them, include them in
retained command arguments, paste them into source, or expose them to a
sandbox/app bundle.

### Convex (`packages/backend`)

| Variable                 | Purpose                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_GATEWAY_URL`      | Public origin of the gateway Worker; `/api/stella/models` advertises it as `gateway.origin`. Required on a `prod:*` deployment; a dev deployment without it advertises an empty origin with one warning. Must be `https`, or `http` on a loopback host. |
| `GATEWAY_SERVICE_SECRET` | Bearer the gateway presents on `/api/gateway/session-capability`, `/usage`, `/config`, `/engine-access`, and `/alerts`. Same value as the Worker secret. |
| `BUILDER_SERVICE_SECRET` | Shared with cloud-builder in both directions: the builder presents it on `/api/cloud/outbox`, `/api/gateway/owner-snapshot`, and the service-secret cloud routes; Convex presents it to the builder on turn starts and snapshot pushes. |
| `CLOUD_BUILDER_URL`      | Builder origin Convex posts turn starts and snapshot pushes to. Without it (or the secret) Convex cannot start a cloud turn. |
| `CAPABILITY_SIGNING_KEY` | PKCS8 PEM private key Convex signs session capabilities with.                                                                |
| `CAPABILITY_SIGNING_KID` | Key id written into the capability header; must match an entry in every `CAPABILITY_JWKS`.                                    |
| `CAPABILITY_JWKS`        | Public `GatewayJwks` document Convex verifies control-plane capabilities against on callback routes. Unset means those routes answer `503`. |
| `STELLA_ADMIN_API_SECRET` | Bearer for the existing Convex admin surface, including owner enforcement and lookup. |
| `ANON_DEVICE_ID_HASH_SALT` | Secret salt for anonymous owner and network request-counter keys. |
| `STELLA_ANON_MAX_REQUESTS` | Anonymous lifetime request allowance per owner. |
| `STELLA_ANON_MAX_REQUESTS_PER_IP` | Anonymous lifetime request allowance per IP bucket; defaults to ten times the owner allowance. |
| `STELLA_ANON_LIFETIME_LIMIT_USD` | Required anonymous monetary allowance. Anonymous account profiles remain on `free`; this value overrides their quota calculation. |
| `STELLA_ANON_ROLLING_LIMIT_USD` | Optional anonymous rolling allowance; defaults to the anonymous lifetime value. |
| `STELLA_ANON_ROLLING_WINDOW_HOURS` | Optional anonymous rolling-window length; defaults to 5 hours. |
| `STELLA_ANON_WEEKLY_LIMIT_USD` | Optional anonymous weekly allowance; defaults to the anonymous lifetime value. |
| `STELLA_ANON_MONTHLY_LIMIT_USD` | Optional anonymous monthly allowance; defaults to the anonymous lifetime value. |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile server secret for anonymous and magic-link account creation plus challenged capability mints. When unset, Turnstile is explicitly off. |
| `STELLA_FREE_EMAIL_ALLOWANCE_SHARE` | Fraction of every Free usage window granted to email-only identities; defaults to `0.4`. |
| `STELLA_EMAIL_DOMAIN_BLOCKLIST` | Optional comma-separated addition to the embedded disposable-email domain blocklist. Subdomains are blocked too. |
| `STELLA_ALERT_WEBHOOK_URL` | Optional Slack-compatible webhook for owner-enforcement status changes and gateway alerts forwarded through `/api/gateway/alerts`. |
| `STELLA_TIER_CEILING_ANON_HOURLY_USD` | Gateway-wide anonymous hourly breaker sent in the config snapshot; defaults to $20, and `-1` disables it. |
| `STELLA_TIER_CEILING_ANON_DAILY_USD` | Gateway-wide anonymous daily breaker; defaults to $200, and `-1` disables it. |
| `STELLA_TIER_CEILING_FREE_HOURLY_USD` | Gateway-wide Free hourly breaker; defaults to $100, and `-1` disables it. |
| `STELLA_TIER_CEILING_FREE_DAILY_USD` | Gateway-wide Free daily breaker; defaults to $1,000, and `-1` disables it. |

### Challenge and identity ladder

Convex assigns each owner an uncached identity level: anonymous `0`, email-only
`1`, Google or Apple `2`, and paid or purchased-credit `3`. Email-only Free
owners receive the configured share of the Free usage windows and one agent
turn per day; anonymous owners keep the separate anonymous allowance and no
agent lane. The level is returned in owner snapshots, subscription status, and
session-capability responses.

Turnstile protects Better Auth's anonymous and magic-link sign-in endpoints and
the custom mobile magic-link sender whenever `TURNSTILE_SECRET_KEY` is set. A
capability mint also requires a valid token when owner enforcement is
`challenged`, or when an unpaid connected owner arrives from a network class in
the gateway's Free challenge policy. Passing the challenge clears challenged
enforcement and pushes the new state to the gateway. Anonymous traffic from a
refused network class remains sign-in-only.

### `stella-v2-model-gateway-dev`

Secrets (all required): `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`,
`DEEPSEEK_API_KEY`, `CROF_API_KEY`, `WAFER_API_KEY`, `XAI_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`,
`META_MODEL_API_KEY`, `GATEWAY_SERVICE_SECRET`, `STELLA_RELAY_PROBE_SECRET`.
`ALERT_WEBHOOK_URL` is an optional secret. When set, tier breaker trips post a
small JSON alert to it.

Vars: `ENVIRONMENT`, `STELLA_CONVEX_SITE_URL`, `CAPABILITY_JWKS` (the public key
set — the placeholder `{"keys":[]}` rejects every capability, which is the
intended fail-closed default until ops replaces it).

Bindings: Durable Object `CAPABILITY_LEDGER` → class `CapabilityLedger`
(migration `v1`, `new_sqlite_classes`); `OWNER_RELAY_GATE` →
`OwnerRelayGate`, `NETWORK_GATE` → `NetworkGate`, and `TIER_BUDGET` →
`TierBudget` (migration `v2`, all three in `new_sqlite_classes`); KV
`OWNER_ENFORCEMENT`; queue producer `USAGE_QUEUE` →
`stella-v2-gateway-usage-dev`; queue consumer on the same queue with
dead-letter `stella-v2-gateway-usage-dlq-dev`; ratelimit `ANON_IP_LIMITER`
(namespace `41011` in development, `41012` in production — the namespace ids must
differ per environment). `limits.cpu_ms` is 60000 because a managed completion
holds the wall clock for minutes.

### `stella-v2-cloud-builder-dev`

Secrets: `BUILDER_SERVICE_SECRET`, `META_MODEL_API_KEY`,
`CAPABILITY_SIGNING_KEY` (PKCS8 PEM for turn capabilities; it never leaves this
Worker).

Vars relevant to the two planes: `CAPABILITY_SIGNING_KID` (`builder-1`),
`MODEL_GATEWAY_URL` (public gateway origin, used by sandboxes and to build the
native CLIs' base URLs), `CLOUD_BUILDER_PUBLIC_URL` (this Worker's own origin — a
Durable Object has no request origin to derive the turn-broker endpoint from),
`STELLA_CONVEX_SITE_URL`, `STELLA_CONVEX_CLOUD_URL`, `TURN_TIMEOUT_MS`.

Bindings: service `MODEL_GATEWAY` → `stella-v2-model-gateway-dev` (Durable
Objects send model traffic through this binding; sandboxes use
`MODEL_GATEWAY_URL` instead); Durable Objects `ORCHESTRATOR_SESSIONS`,
`BUILD_SESSIONS`, `OWNER_GATES`, `OWNER_TRANSFER_COORDINATORS`, `Sandbox`,
`SANDBOX_SMALL`, `APP_BUILD_SANDBOX`; queue producer `TURN_OUTBOX` →
`stella-v2-turn-outbox-dev` with a consumer on the same queue and dead-letter
`stella-v2-turn-outbox-dlq-dev`; R2 `APP_BUILDS`, `BACKUP_BUCKET`, `AGENT_HOME`,
`CONVERSATION_ARCHIVE`; KV `APP_ROUTES`.

Migrations: `v7` created `OwnerGate` as a SQLite class; `v8` deletes
`DevicePresence`, whose socket now lives inside the owner gate. Both must be
present in every environment block before deploying.

### `stella-v2-apps-host-dev` / `stella-v2-interior-dev`

`BUILDER_SERVICE_SECRET` must equal the credential the Convex interior-route
endpoint expects; the stable `/stella/<stableRouteId>/` surface fails closed with
`503` without it. `EMBED_APPS_ORIGIN` carries the framing contract (below).

## Deploy

Never deploy from either v1 repository. Run commands from the v2 worktree, and
retrieve credentials from the v2 Convex environment without printing them.

Cloudflare credentials for every Worker deploy:

```sh
export CLOUDFLARE_API_TOKEN="$(cd packages/backend && bunx convex env get CLOUDFLARE_API_TOKEN)"
export CLOUDFLARE_ACCOUNT_ID="$(cd packages/backend && bunx convex env get CF_ACCOUNT_ID)"
# … deploy …
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
```

A fresh environment comes up in this order, because each step's bindings must
already exist:

**1. Queues.** A Worker with a producer or consumer binding fails to deploy if
its queue is missing, and a dead-letter queue must exist before the consumer
that names it.

```sh
bunx wrangler queues create stella-v2-gateway-usage-dev
bunx wrangler queues create stella-v2-gateway-usage-dlq-dev
bunx wrangler queues create stella-v2-turn-outbox-dev
bunx wrangler queues create stella-v2-turn-outbox-dlq-dev
```

**2. Model gateway.** Generate both key pairs first, set the gateway's
`CAPABILITY_JWKS` var to the public document, then the secrets, then deploy. The
gateway must exist before the builder, which binds to it as a service.

Create separate owner-enforcement namespaces and replace `REPLACE_ME_DEV` and
`REPLACE_ME_PROD` in `workers/model-gateway/wrangler.jsonc` with the returned
ids before deployment:

```sh
cd workers/model-gateway
bunx wrangler kv namespace create OWNER_ENFORCEMENT --env=""
bunx wrangler kv namespace create OWNER_ENFORCEMENT --env=production
```

```sh
bun scripts/generate-capability-keys.mjs convex-1
bun scripts/generate-capability-keys.mjs builder-1
cd workers/model-gateway
# put each provider key, GATEWAY_SERVICE_SECRET, STELLA_RELAY_PROBE_SECRET
bunx wrangler secret put OPENAI_API_KEY --env=""
# optional: bunx wrangler secret put ALERT_WEBHOOK_URL --env=""
bun run deploy:dev            # or, from the repo root: bun run model-gateway:deploy:dev
```

**3. Cloud builder.**

```sh
cd workers/cloud-builder
bunx wrangler secret put CAPABILITY_SIGNING_KEY --env=""   # builder-1 private PEM
bunx wrangler secret put BUILDER_SERVICE_SECRET --env=""
bun run deploy:dev
```

**4. Convex environment.** Set every variable from the Convex table above,
piping secret values rather than passing them as retained arguments.

```sh
cd packages/backend
bunx convex env set MODEL_GATEWAY_URL https://stella-v2-model-gateway-dev.lolruuxi.workers.dev
bunx convex env set CLOUD_BUILDER_URL https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev
bunx convex env set CAPABILITY_SIGNING_KID convex-1
# CAPABILITY_SIGNING_KEY, CAPABILITY_JWKS, GATEWAY_SERVICE_SECRET, BUILDER_SERVICE_SECRET
```

**5. Convex deploy.**

```sh
cd packages/backend
bunx convex dev --once     # production: bunx convex deploy
```

**App and interior hosts** are independent of the turn plane and deploy on their
own schedule:

```sh
cd workers/apps-host
bunx wrangler deploy --config wrangler.jsonc
bunx wrangler deploy --config wrangler.interior.jsonc
```

Publish an interior by building the renderer with `NODE_ENV=production` set
explicitly (a leaked `NODE_ENV=development` makes Vite emit a dev-flagged
bundle), zipping the dist as `interior-bundle.zip`, then running
`workers/apps-host/scripts/publish-interior.mjs <dist> <new-prefix>` with the R2
credentials piped from Convex, and atomically replacing `app:stella-interior` in
KV. Never overwrite an existing prefix. The manifest endpoint must return the new
prefix before mobile rollout.

Framing contract: the interior worker's CSP must carry
`frame-src <apps host origin>` (via `EMBED_APPS_ORIGIN`) and the apps host's
`frame-ancestors` must include the interior origin, or embedded apps silently
render as a blocked frame.

Rotate a secret by updating both stores, deploying both sides, exercising health
plus a real turn, then revoking the previous value.

For owner enforcement, verify the existing admin bearer on both new Convex
routes. `POST /api/admin/owners/enforcement` accepts exactly one of `ownerId` or
`email` plus `status`, optional `until`, and `reason`. Then call
`GET /api/admin/owners/lookup?ownerId=…` (or `?email=…`) and confirm the response
contains the resolved owner, anonymous flag, plan, effective enforcement,
billing-window remainder, unreleased grants, and up to 50 recent gateway usage
receipts. A suspended owner must produce a snapshot with `writable: false`, and
`POST /api/gateway/session-capability` must answer `403 owner_suspended`.

## Verification

Per package, from the repository root unless a `cd` is shown:

```sh
cd packages/backend && bun run typecheck && bun run test && bun run test:convex
bun run runtime:typecheck
cd packages/desktop-ui && npx vitest run tests/runtime
cd workers/model-gateway && bun run typecheck && bun test tests && bunx wrangler deploy --dry-run --env=
cd workers/cloud-builder && bun run typecheck && bun test tests
cd packages/executor-cloud && bun run typecheck && bun test src
bun run lint
```

Known failures that predate the two-plane work — a run is green when these, and
only these, fail:

- `packages/backend` `test:convex`:
  `managed_alternate_writer_inventory.convex.test.ts` reports
  `http_routes/dictation.ts` as an alternate managed-billing writer. Dictation
  still meters through `internal.billing.logManagedUsage` directly.
- `packages/desktop-ui` `tests/runtime`:
  `tests/runtime/kernel/runner/context-model-precedence.test.ts`.
- `bun run lint`: one `no-empty` at
  `packages/desktop-ui/src/platform/ui-state/index.ts:157`.
- `workers/cloud-builder` `bun test tests`: the two
  `tests/sandbox-egress-workerd.test.ts` cases, which need a local Docker
  daemon and a workerd child process.

## Cloud orchestrator

The `OrchestratorSession` runs the same loop _configuration_ as the desktop
runtime, not just the same loop. Its tool set is pinned in code (`spawn_agent`,
`send_input`, `pause_agent`, `web`) and it never attaches a sandbox — a plain
chat turn costs tokens only.

- **Transcript.** The journal is a single ordered `seq` covering messages, turn
  lifecycle records, and UI cards, in the object's SQLite. One object per
  conversation means desktop and phone writing to the same conversation are
  serialized by construction. Clients read it over a hibernatable WebSocket at
  `GET /conversations/:conversationId/socket`, authenticated by the user's Better
  Auth JWT in the Worker before the object is addressed. Older rows roll into
  gzipped R2 segments in `CONVERSATION_ARCHIVE`, with the object holding the
  manifest.
- **Convex projection.** `cloud_conversations` (the one question a
  per-conversation object cannot answer: list my conversations). It is written
  only through `conversation.created` / `conversation.index` outbox events and is
  regenerable from the journal. Nothing in Convex may read one of its fields and
  act on it as truth. There is no transcript copy in Convex.
- **Recall.** The orchestrator's Recall tool searches THIS conversation's own
  journal: `journal_fts`, an SQLite FTS5 table (`porter unicode61`) inside the
  object, indexing user and assistant message text keyed by `seq`
  (`transcript-search.ts`). The index survives rollover to R2 because it is a
  separate table; hits are hydrated back to the real records around each `seq`
  through `archive.readRange`, so the model sees what was actually said rather
  than a digest. Recall never calls Convex mid-turn, never searches other
  conversations, and is not semantic. The lifetime ceiling per conversation is
  `CONVERSATION_MAX_STORED_BYTES` (4 GiB across resident rows, R2 segments and
  spills); only the text index has to fit in the object's 10 GB SQLite.
- **Persona.** The system prompt is built from the canonical
  `agents/orchestrator.md` body served by `/api/stella/prompts` (ETag-cached in
  object storage, refreshed at most every 5 min), plus a cloud overlay
  (`cloud-prompt.ts`) that overrides only what is physically different: tool
  surface, no local machine, app/Stella apply semantics, no local file links. A
  cold object that cannot reach Convex degrades to the compact fallback prompt.
  Personality is the user's `PERSONALITY.md` from their R2 agent home when
  present, else the canonical `prompts/personality-stella.md`. Reply language
  comes from the composer's UI locale, persisted per conversation.
- **Loop config.** `thinkingLevel` resolves from the model's reasoning flag
  exactly as desktop does; desktop's `transformContext` re-prunes and strips
  stale images before every provider call; `degenerateResponseRetries: 0` plus
  `providerRequestLimit` match desktop because the outer ladder owns retries.
- **Transient retry ladder.** Both cloud loops wrap the loop in desktop's
  `executeAgentRunWithRetry` — 4 attempts over retryable provider/transport/
  empty-completion failures, resuming the same in-memory context after popping
  the errored tail. The object wires the ladder's abort signal to its
  cancel/timeout paths so a terminal turn never retries.
- **Context budget.** Both loops prune loaded history to a ~48k-token newest
  window cut at a `user`-message boundary
  (`@stella/executor-cloud/prune-history`), so a long conversation degrades
  gracefully instead of bricking on context overflow.
- **`web` tool.** The exact desktop surface (`kernel/tools/defs/web-def.ts`) and
  fetch pipeline (`kernel/tools/web-fetch-core.ts`): readable-text extraction,
  manual redirects with per-hop SSRF re-validation through the shared guard
  (`kernel/tools/url-guard.ts`). Desktop adds a DNS resolution check on top;
  workerd has no resolver hook and leans on platform egress policy.
- **Attachments.** Drive images attached in the composer ride the turn as real
  image blocks: the turn start carries drive paths (≤ 4), the object hydrates
  them through `/api/cloud/drive/attachments` with the control-plane capability
  (images only, ≤ 3 MB each, 120 s signed GETs). The prompt text still names the
  paths so later turns reach the files through the drive.
- **Deliberately absent tools**, each blocked on a concrete constraint and listed
  in the object's tool catalog and the persona overlay: `Read`, `html`,
  `image_gen`, `view_image`, `map`, `tool_search`, `spawn_manager`.

Spawned agents run in a `BuildSession`. `kind: "agent"` turns restore the
workspace checkpoint, run the real runtime headless via
`executor-cloud --agent-turn` (pinned tools: `exec_command`, `write_stdin`,
`node_repl`, `apply_patch`, `web`, `view_image`, `Read`), checkpoint, and report.
A sandbox receives the turn's model capability and nothing else — never a
provider key, never an account credential, never the control-plane capability.

Spawn placement is the `workspace` argument (`cloud`, `computer`,
`project:<name>`, `stella`, `app:<slug>`). `computer` is the one local placement
and needs a reachable desktop; every other explicit workspace runs in Stella's
cloud. Workspace persistence is a Sandbox backup per `(owner, workspace)` whose
descriptor lives in KV under `ws:<sha256(owner:workspace)>` — sandbox disk is a
cache, the checkpoint is truth. Checkpoint rotation records cleanup debt before
changing the pointer, deletes failed-attempt and superseded backup bytes, and
surfaces cleanup/checkpoint failure rather than silently reporting completion.
The owner gate's one-running-agent-per-workspace rule is what keeps
last-writer-wins checkpoints from losing work.

Turn dispatch is asynchronous throughout: `202` first, run detached, outcomes
delivered as `turn.event` projections and — for a spawned agent — a direct wake
of the parent object. Both watchdog alarms mark the turn terminal _and_ abort the
in-flight loop or destroy the sandbox, so there is no post-timeout token burn.

### Cloud engines (user subscriptions)

Desktop's engine choice (Stella runtime / Claude Code / Codex, backed by
keychain-stored OAuth tokens) has a cloud counterpart. Credentials live in
`cloud_llm_credentials` — AES-256-GCM encrypted with the server-held
`CLOUD_LLM_CREDENTIALS_KEY` env var — and are the durable login that survives
across sandbox instances. Tokens are never returned to clients, never enter a
Durable Object or a sandbox, and refresh server-side (`cloud_engines.ts`
`resolveEngineAccess`, called by the model gateway through
`/api/gateway/engine-access`, persists rotated tokens).

- **Connect (web-friendly, paste-based):** `startEngineConnect` mints PKCE
  server-side and returns only the authorize URL; the user approves in their
  browser and pastes the code (Claude) or the full localhost redirect URL
  (ChatGPT — the page will not load, the address bar still carries the code) into
  `finishEngineConnect`. UI: `CloudEnginesCard` on Settings → Account.
- **Selection:** `cloud_engine_settings.execution` persists the exact engine,
  provider, native model, and reasoning effort (`stella`, `anthropic`, or
  `openai-codex`); it is the owner snapshot's default execution and is copied
  onto every turn at admission. Cloud `spawn_agent` can override one child with
  `claude[/model]:<effort>`, `codex[/model]:<effort>`, or a canonical
  `stella/...` route. The owner gate refuses an execution whose engine has no
  live credential with `execution_unavailable`.
- **Native execution:** the sandbox image pins and runs the real Claude Code and
  Codex CLIs against the gateway's native lane, with the turn capability as their
  bearer. Codex keeps its normal native tool surface. Claude matches Stella's
  desktop configured-engine takeover: Claude owns the native loop, while
  `--tools ""`, disabled slash commands, and a private authenticated loopback MCP
  host replace its built-ins with the same pinned Stella cloud tools used by the
  in-process engine. Ambient/user MCP servers and persisted user/project/local
  settings (including hooks and plugins) are excluded, and Stella's cloud
  General-agent prompt replaces Claude's default prompt.

Engine dev probes: `cloud_engines:connectProbeInternal` (key + authorize URL
construction), `seedEngineProbeInternal` / `resolveEngineProbeInternal` /
`clearEngineProbeInternal` (fake-credential pipeline exercise; booleans only,
never token material).

## App hosting and the Stella interior

`stella-v2-apps-host-dev` is the app data plane. A KV record maps an app slug to
an immutable R2 artifact prefix. `index.html` is served without caching; hashed
assets are immutable. Every app gets a distinct origin when the production
wildcard domain is configured. A strict CSP limits scripts, connections,
embedding origins, and object loading. Suspended KV routes return a static notice
without reading app assets.

`stella-v2-interior-dev` runs the same hosting code with a distinguished
`stella-interior` route. Desktop/web load it directly. Mobile downloads its
versioned ZIP manifest, expands it into app-private storage, keeps the current
version available offline, downloads updates in the background, and swaps on the
next foreground.

### Stella interior self-modification

The packaged desktop is a stable shell; Stella's renderer is a separately
versioned artifact. A cloud child spawned with `workspace: "stella"` restores the
owner's long-lived renderer source checkpoint, edits the existing source, and
runs the pinned production Vite builder. The builder requires all four entry
documents (`index.html`, `mini.html`, `overlay.html`, `pet.html`), injects the
canonical renderer CSP before hashing, validates bounded paths, symlinks, counts,
and sizes, then uploads files under the immutable R2 prefix
`interiors/<ownerHash>/<buildId>/`. Convex independently verifies the manifest
carried by the `interior-build.recorded` outbox event and records a candidate; it
never auto-selects one.

The user selects or rolls back candidates in Settings. The mutable Convex row is
only a compare-and-swap pointer (`activeBuildId`, `previousBuildId`,
`routeRevision`). A packaged shell downloads every file over HTTPS, rejects
redirects and manifest/hash/size/ABI/version drift, stages atomically, and
promotes only after exact-path React readiness and stabilization in full, mini,
overlay, and pet windows. Failed trials are quarantined and restore the last
known good artifact or packaged renderer.

The standalone web URL is `/stella/<stableRouteId>/`. `stableRouteId` is a
random, user-rotatable capability rather than a derivation of account identity;
the host resolves it through the service-authenticated Convex route on every
request so rotation revokes the old URL immediately. It serves the selected
immutable candidate with `no-store`, or the published default interior when no
candidate is selected. The renderer then establishes its own Better Auth browser
session; the capability selects presentation, not account authority.

The apps SDK selects one of two transports without changing its API: inside
Stella, `postMessage` reaches the shell bridge; in a plain browser, same-origin
HTTP reaches apps-host. The SDK exposes scoped identity, quota-limited storage,
share, and proxied public-HTTPS fetch. Apps never receive Convex credentials or
Stella secrets.

## Development resources

| Resource         | Development value                                    |
| ---------------- | ---------------------------------------------------- |
| Convex           | `outgoing-bulldog-865`                               |
| Model gateway    | `stella-v2-model-gateway-dev.lolruuxi.workers.dev`   |
| Builder          | `stella-v2-cloud-builder-dev.lolruuxi.workers.dev`   |
| Apps host        | `stella-v2-apps-host-dev.lolruuxi.workers.dev`       |
| Trusted app auth | `stella-v2-apps-auth-dev.lolruuxi.workers.dev`       |
| R2               | `stella-v2-app-builds-dev`                           |
| KV               | `dc5c7bac2bd04ec7bbd6a89f18a04ee7`                   |
| Usage queue      | `stella-v2-gateway-usage-dev` (+ `-dlq-dev`)         |
| Outbox queue     | `stella-v2-turn-outbox-dev` (+ `-dlq-dev`)           |
| Desktop renderer | `http://127.0.0.1:57315`                             |

Only development-tier resources are automated. Production domains, DNS,
cutover, and store submission require the owner.

## Activation and rollback

Nothing activates because a turn finished. A finished app build records a pending
candidate in `cloud_app_builds` through the `build.recorded` outbox event and
leaves the app's route untouched, so the build lane never writes the `APP_ROUTES`
KV namespace. The user applies a candidate to make it live.

Activation is the same three steps for a first apply, a later apply, or a
rollback:

1. validate ownership of app and build in Convex;
2. write the new KV route through builder `/routes/activate`;
3. atomically mark the build active in Convex.

Applying a build and rolling back to any of the five retained builds are the same
operation with a different target. Do not copy artifacts or mutate an existing
prefix. Confirm the deployed URL returns 200 and the expected UI, then confirm
Convex's `activeBuildId`.

Stella's own interior takes one extra step. Its production build runs only when
the agent asks for it during a turn, by calling the `publish_stella_interior`
tool; the request is recorded through the turn broker and the build runs after
the turn succeeds. The build then does not switch any client on its own: the
Settings card selects the immutable candidate through Convex CAS. The standalone
web capability resolves that pointer on each request. Each packaged desktop
independently downloads and verifies the candidate, runs its four-surface
readiness trial, and only then records it as locally healthy. Selecting "Use
packaged" clears the active pointer; the same stable web URL falls back to the
published default interior. A rejected desktop candidate requests a control-plane
rollback and remains quarantined locally.

## Suspend and restore

Suspension writes `suspended: true` to the slug's KV record through
authenticated builder `/routes/suspend`, then marks the Convex app suspended.
Verify the app URL returns HTTP 403 with the static "App suspended" notice.

Restore by activating a known retained build and clearing suspension through
`/routes/activate`, then make the same build active in Convex. Verify HTTP 200
and visually exercise the app. Do not delete R2 artifacts as part of moderation.

The global emergency switch is `SHARES_DISABLED=true` on apps-host. It disables
all app routes and is reserved for an incident, not routine moderation.

## Turn recovery

Each `BuildSession` stores its turn and sandbox id in Durable Object storage and
sets a wall-clock alarm. Cancel and timeout both destroy the current sandbox,
write a terminal event best-effort, and are idempotent. Convex rejects events
after the first terminal one, and the outbox receipt deduplicates redeliveries.

For a stuck turn:

1. inspect Convex `agent_turns` and ordered `agent_events`. For a **chat** turn
   the transcript is not in Convex — read the object's journal directly with the
   dev probe (`GET /conversations/:id/journal?limit=&beforeSeq=`, service
   secret, or `cloud_apps:getConversationProbeInternal`). There are no tests by
   owner decision, so this probe is the verification tool: it also reports
   `headSeq`, `indexSyncedSeq`, `pendingExcerpts` (turns still owed to the Convex
   search projection), hot-tier stats, inbox depth, `databaseBytes`,
   `storedBytes` (resident plus archived — what the per-conversation ceiling is
   measured against), `spillObjects`, purge-queue depth, and the object's wake
   state: `alarmAt`, the turn ids still durable under `queued:`, and `sealed`.
   The invariant to check there: an accepted turn always has a pending alarm, so
   `queued` non-empty with `alarmAt: null` is a stranded turn that nothing will
   ever wake;
2. inspect builder structured logs by `turnId`;
3. check the owner gate: `OwnerGate.status()` lists the running rows holding
   concurrency, and a row older than `TURN_TIMEOUT_MS` + 60 s is already treated
   as released;
4. call the authenticated cancel path if the object is still alive;
5. confirm the sandbox is destroyed and the turn is terminal;
6. retry as a new turn — never rewrite the old event stream.

For a stuck projection, check the outbox: `outbox_delivery_retrying`,
`outbox_batch_refused`, and `outbox_event_rejected` log lines name the batch and
the reason, and the dead-letter queue holds anything that exhausted its retries.

## Index projection and conversation deletion

The index row is the only Convex projection of a conversation and it is
regenerable: a lagging row (`meta.index_synced_seq` behind the head) re-flushes
at every turn end and every socket connect, so a live conversation converges
without an operator. There is no `/reindex` route any more; the search index is
the object's own FTS5 table and is rebuilt only by the journal schema migration.

Per-conversation deletion is a two-party handshake and the object's **body** is
the verdict, not its status. `POST /conversations/:id/purge` answers
`202 {purged:false, pending:N}` when it could not delete `N` R2 objects; in that
case it deliberately keeps its SQLite — the segment manifest is the only record
of those keys — and Convex leaves `purgedAt` unset so `sweepDeletedConversations`
retries. Account deletion's durable gate stays open for the same reason. If a
conversation is stuck unpurged, check builder logs for
`conversation_purge_delete_failed` before assuming Convex is at fault.

A finished purge leaves a row in `cloud_conversation_tombstones`, and it is the
fence that keeps the deletion permanent: an index flush that a resident object
started before the purge can land minutes later, and without the fence the index
projection would treat the missing row as a lost one and rebuild it — with the
conversation's excerpts — from the object's own `meta`. It cannot be the index row
itself, because account deletion has to delete that row: it carries `ownerId`.
The tombstone carries a random conversation UUID and the instant the object
confirmed its storage was gone, nothing else, so it survives the owner without
retaining anything about them; `sweepConversationTombstonesInternal` retires it
after 30 days, far beyond the lifetime of any in-flight flush. A refused flush is
rejected as `purged` and the object seals itself on that reply
(`conversation_sealed_after_purge`) rather than retrying.

## Operations layer (two-speed agents)

Mini apps expose two agent lanes over one document of state. The build lane is
the existing source-edit → sandbox → immutable artifact → apply-card path,
entered through Convex `cloud_apps:startAppBuildTurn` (app targets only). The
operations lane lets the agent act as a _user_ of the running app: the app
declares named, deterministic operations, the model only picks a verb and
arguments, and ordinary in-app code applies the change. The app's own UI controls
and the agent invoke the same functions — one implementation, no separate AI
path. Plain chat never enters either lane; the orchestrator delegates builds
through its spawn tool.

### App-side convention

The template ships `src/operations.ts`: deterministic functions over the app's
state store with in-app argument validation, plus `createAppOperations`, which
binds those functions to SDK operation definitions. UI controls call the same
functions directly. Durable state lives in `stella.storage` (the app persists its
state document after every mutation and hydrates it on load); operations mutate
the live in-memory state and render immediately.

Apps register operations through the SDK only:

```ts
await stella.operations.register([
  {
    name: "set-habit-progress",
    description: "…",
    args: [
      { name: "habit", type: "string", required: true },
      { name: "progress", type: "number", required: true },
    ],
    handler: (args) => fns.setHabitProgress(args),
  },
]);
```

`register` publishes a manifest (names, argument descriptors, descriptions —
never handlers) to Convex and starts listening for invocations. Apps never see
Convex directly; the SDK remains the only boundary. Manifest writes are accepted
only from owner sessions and are capped: at most 20 operations, 8 arguments each,
kebab-case names ≤ 64 chars, descriptions ≤ 200 chars, 8 KB of manifest JSON.

### Data model

- `cloud_app_operations` — one row per app: the current manifest JSON and its
  size, replaced idempotently on registration.
- `cloud_app_op_invocations` — one row per agent invocation: `invocationId`,
  `appId`, `ownerId`, `turnId`, `name`, `argsJson`, `status`
  (`pending → delivered → completed | failed`, or `expired`), result/error and
  timestamps.
- `agent_turns.lane` — `"build"`, `"operation"`, or `"auto"` while routing. Turn
  records stay executor-agnostic: the lane names the dispatch path, and
  everything the agent did is visible as ordered `agent_events`.

### Turn routing

`startAppBuildTurn` keeps the build path unchanged for new apps and for apps
without a manifest. When the target app is active and has registered operations,
the mutation records the turn with `lane: "auto"` and schedules
`routeCloudTurnInternal` instead of dispatching the builder directly. The router
makes one small model call (Claude Haiku, JSON-only) with the user request and
the manifest, instructed to prefer operating the running app and to choose
`build` only for structural/code/visual changes. Then:

- **operation** — validate the verb against the manifest, write the invocation
  row, log an `op_selected` turn event, and schedule a 20-second expiry. No
  sandbox, no build, no apply card; the executor is never involved.
- **build** — re-check the plan's build quota (op turns never reserve build quota
  up front), set `lane: "build"`, and dispatch the existing builder path. Quota
  failures terminalize the turn with the standard readable message.

Completion is reported by the platform surface that delivered the invocation: a
`completed` (or `failed`) terminal event carries the operation name, arguments,
and the app-returned result, so the chat timeline shows exactly what the agent
did.

### Live reach

Delivery targets a running instance the owner has open:

- **In-shell (iframe bridge)** — the app page subscribes to pending invocations
  for its app, claims each one atomically (`pending → delivered`, so two open
  tabs never double-fire), forwards it to the iframe over `postMessage` with the
  existing origin checks, and reports the app's result back to Convex. The SDK
  validates arguments against the registered definition in-app before running the
  handler.
- **Standalone (HTTP)** — the SDK polls `/api/apps/operations/poll` with its
  app-session token while the page is visible. Only sessions whose user is the
  app owner are eligible; anonymous sessions are told once and never poll.

If no eligible instance claims the invocation before expiry, the turn fails
gracefully within ~20 seconds: "Open the app, then ask again." No queueing in v1
— rejected invocations are never executed later against stale intent.

### Safety and quotas

Operations are app-defined untrusted code and run only inside the app's own
origin-isolated instance; the platform never executes them. Argument validation
lives in-app (SDK schema check plus the operation's own semantic checks). The
platform enforces: owner-only routing and delivery, origin/session verification
on every transport, manifest and argument size caps (8 KB), result caps (8 KB),
and plan-scaled limits — op turns draw from their own budgets
(`burstStarts × 5` per 10 minutes, `dailyTurns × 20` per rolling 24 hours) so a
chatty operator lane can never starve or bypass build quotas. No new secret
paths: invocations carry only the verb and JSON arguments; results carry only
app-returned JSON.

## Observability and alerts

Every Worker has invocation logs enabled and emits JSON records with `service`,
`event`, and `timestamp`. Apps-host records request paths, missing assets,
suspended notices, manifest failures, and the kill switch. Builder records
request entry, turn start/completion/failure/timeout/cancel, outbox delivery
verdicts, owner-snapshot staleness, and route changes. The gateway logs one line
per completed relay with the trace id, agent type, requested and resolved model,
provider, protocol, status, charged micro-cents, and duration. Prompts,
authorization headers, capabilities, and secrets are never logged.

Use a short live tail during an incident:

```sh
bunx wrangler tail stella-v2-model-gateway-dev --format pretty
bunx wrangler tail stella-v2-cloud-builder-dev --format pretty
bunx wrangler tail stella-v2-apps-host-dev --format pretty
```

The Convex cron `cloud app failure spike detection` runs every five minutes. It
opens a persistent `cloud_failure_alerts` row when at least three failed or
timed-out turns occur in 15 minutes, emits a structured error log, and resolves
the open alert once the window is healthy. Inspect recent rows with:

```sh
cd packages/backend
bunx convex run cloud_apps:listFailureAlertsInternal '{}'
```

Production should route the structured Convex error event to the owner's alert
destination after cutover. The persisted row is the minimum reliable alert source
even when log delivery is delayed.

## Release checklist

Before production:

- create the production queues and the production ratelimit namespace, and mint
  a separate production key pair per capability issuer;
- configure the production apps wildcard domain and DNS;
- create the v2 production Convex deployment and perform the controlled domain
  cutover;
- re-point Stripe webhooks and Better Auth/Apple sign-in URLs;
- confirm the Stripe plan-to-quota mapping above;
- submit the existing-listing iOS and Android shell updates;
- obtain/verify the CarPlay entitlement and complete an on-head-unit
  dictation/cloud-reply/TTS pass;
- configure log-based paging from the persisted Convex failure alert;
- rotate the Apple sign-in private key and JWKS that appeared in a local planning
  transcript on 2026-07-12.

## Removed

Searching for one of these will find nothing; here is where the behavior went.

**Convex HTTP routes.** `/api/stella/relay*` and `/api/stella/cloud-model` (the
streaming relay) → the model gateway's `/v1/relay/*`. `/api/cloud/events`,
`/api/cloud/index`, `/api/cloud/messages`, `/api/cloud/threads/complete` → outbox
events `turn.event`, `conversation.index`, `thread.completed` (thread messages
are no longer projected at all). `/api/cloud/recall` → the object's own FTS5
index (`transcript-search.ts`). `/api/cloud/context` → the `BuildSession`'s own
`thread_messages` table. `/api/cloud/spawn` → `OrchestratorSession` calls
`BuildSession` directly. `/api/execution-placement/*` and
`/api/mobile/execution/*` → the owner gate's `/owners/me/dispatches` and presence
socket.

**Convex functions.** `startCloudChat` (the chat lane; the app build/ops lane
survives as `startAppBuildTurn`), `runOrchestratorTurnInternal`,
`runCloudAgentTurnInternal` and their retry ladders,
`completeAgentThreadInternal`'s wake, `storeTurnTokenInternal`,
`ensureTurnTokenForDispatchInternal`, `getTurnTokenByHashInternal`,
`logRelayManagedUsage`, `relay_resume_store`, `decideServerExecutionPlacement`
(ported to `workers/cloud-builder/src/dispatch-policy.ts`).

**Convex tables.** `cloud_turn_tokens` and its SHA-256 hash index → signed turn
capabilities verified against `CAPABILITY_JWKS`. The eight `relay_resume` tables
→ nothing; request/response has no frame journal, and the gateway's ledger caches
one completed result per request id for 10 minutes. Execution placement's
dispatch/device/presence tables → the owner gate's SQLite, with a single
`cloud_dispatches` projection left for the activity UI. `cloud_thread_messages`,
`cloud_message_excerpts` and the legacy `cloud_messages` table → nothing; the
authoritative thread transcript is the `BuildSession`'s, and Recall searches the
conversation object's own FTS5 index.

**Convex files.** `convex/stella_provider.ts` and `convex/stella_provider/*`,
`convex/native_relay.ts`, `convex/schema/relay_resume.ts` — the reusable parts
moved to `packages/model-catalog`, the rest to `workers/model-gateway`.

**Crons.** Relay-resume purge, turn-token purge, and the 30-second execution
placement reconcile pass. Reconciliation is now an alarm inside the owner gate.

**Cloudflare.** The `DevicePresence` Durable Object class (migration `v8`
`deleted_classes`) → the `OwnerGate`'s presence socket. The turn-credential
broker's `model-relay` and `model-resolution` targets → sandboxes hold a
turn-scoped model capability and talk to the gateway directly.

**Concepts.** "Turn token" is now "turn capability", and there are two of them
per turn with different audiences. "Execution placement" is now "dispatch", and
it lives in the owner gate. Convex is no longer the dispatcher of anything on the
turn path.
