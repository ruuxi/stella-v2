# Stella cloud apps

This document is the operating guide for Stella v2's cloud-first chat, app
builder, hosting layer, standalone interior, and mobile shell. The development
stack described here is intentionally isolated from Stella v1.

## Architecture

Convex deployment `flexible-panther-999` is the canonical control plane. It
owns conversations, turns, ordered events, app/build metadata, per-app user
storage, billing-plan lookup, quota enforcement, and failure alerts. Desktop,
the standalone web interior, iOS, Android, and CarPlay all submit through the
same `cloud_apps:startCloudChat` mutation and subscribe to the same tables.

`stella-v2-cloud-builder-dev` is the authenticated execution plane. A
`BuildSession` Durable Object owns each turn, starts a Cloudflare Sandbox
container, invokes the headless Effect runtime, streams ordered callbacks to
Convex, checkpoints/restores the workspace, uploads the production build to R2,
and always writes one terminal event. Sandboxes receive a short-lived turn
token, never provider or account credentials.

`stella-v2-apps-host-dev` is the app data plane. A KV record maps an app slug to
an immutable R2 artifact prefix. `index.html` is served without caching; hashed
assets are immutable. Every app gets a distinct origin when the production
wildcard domain is configured. A strict CSP limits scripts, connections,
embedding origins, and object loading. Suspended KV routes return a static
notice without reading app assets.

`stella-v2-interior-dev` runs the same hosting code with a distinguished
`stella-interior` route. Desktop/web load it directly. Mobile downloads its
versioned ZIP manifest, expands it into app-private storage, keeps the current
version available offline, downloads updates in the background, and swaps on
the next foreground.

The apps SDK selects one of two transports without changing its API:

- inside Stella, `postMessage` reaches the shell bridge;
- in a plain browser, same-origin HTTP reaches apps-host.

The SDK exposes scoped identity, quota-limited storage, share, and proxied
public-HTTPS fetch. Apps never receive Convex credentials or Stella secrets.

## Development resources

| Resource | Development value |
| --- | --- |
| Convex | `flexible-panther-999` |
| Builder | `stella-v2-cloud-builder-dev.lolruuxi.workers.dev` |
| Apps host | `stella-v2-apps-host-dev.lolruuxi.workers.dev` |
| Interior | `stella-v2-interior-dev.lolruuxi.workers.dev` |
| R2 | `stella-v2-app-builds-dev` |
| KV | `dc5c7bac2bd04ec7bbd6a89f18a04ee7` |
| Desktop renderer | `http://127.0.0.1:57315` |

Only development-tier resources are automated. Production domains, DNS,
cutover, and store submission require the owner.

## Plan and abuse controls

`startCloudChat` resolves the authenticated owner's active billing profile,
falls back to Free for inactive subscriptions, and treats the existing
`unlimited` usage mode as Max. It then enforces a fixed-window start limit,
rolling 24-hour turn quota, and active-turn concurrency before creating any
turn or scheduling the builder.

| Plan | Turns / rolling 24 h | Concurrent turns | Starts / 10 min |
| --- | ---: | ---: | ---: |
| Free | 3 | 1 | 4 |
| Go | 10 | 1 | 6 |
| Pro | 25 | 2 | 10 |
| Plus | 50 | 3 | 16 |
| Ultra | 100 | 4 | 24 |
| Stella Max | 200 | 6 | 40 |

These are the shipping guardrails for the development phase. Product/finance
must confirm the plan-to-build mapping before production cutover. Changes belong
in the single `CLOUD_PLAN_QUOTAS` table in `convex/cloud_apps.ts`.

## Deploy

Never deploy from either v1 repository. Run commands from the v2 worktree, and
retrieve credentials from the v2 Convex environment without printing them.

Deploy Convex:

```sh
cd convex
bunx convex dev --once
```

Deploy the builder:

```sh
cd workers/cloud-builder
export CLOUDFLARE_API_TOKEN="$(cd ../../convex && bunx convex env get CLOUDFLARE_API_TOKEN)"
export CLOUDFLARE_ACCOUNT_ID="$(cd ../../convex && bunx convex env get CF_ACCOUNT_ID)"
bun run deploy:dev
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
```

Deploy app and interior hosts:

```sh
cd workers/apps-host
export CLOUDFLARE_API_TOKEN="$(cd ../../convex && bunx convex env get CLOUDFLARE_API_TOKEN)"
export CLOUDFLARE_ACCOUNT_ID="$(cd ../../convex && bunx convex env get CF_ACCOUNT_ID)"
bunx wrangler deploy --config wrangler.jsonc
bunx wrangler deploy --config wrangler.interior.jsonc
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
```

Publish an interior by building the renderer, uploading the dist directory and
ZIP under a new immutable R2 prefix, then atomically replacing
`app:stella-interior` in KV. Never overwrite an existing prefix. The manifest
endpoint must return the new prefix, ZIP content type, immutable cache policy,
and an ETag before mobile rollout.

## Apply and rollback

A non-initial turn creates a pending build. Activation is an explicit user
action:

1. validate ownership of app and build in Convex;
2. write the new KV route through builder `/routes/activate`;
3. atomically mark the build active in Convex.

Rollback is the same operation pointed at any of the five retained builds. Do
not copy artifacts or mutate an existing prefix. Confirm the deployed URL
returns 200 and the expected UI, then confirm Convex's `activeBuildId`.

If activation succeeds in KV but the Convex mutation fails, repeat the same
idempotent activation. If Convex succeeds but KV fails, the action returns a
readable error and leaves the prior route serving.

## Suspend and restore

Suspension writes `suspended: true` to the slug's KV record through authenticated
builder `/routes/suspend`, then marks the Convex app suspended. Verify the app
URL returns HTTP 403 with the static “App suspended” notice.

Restore by activating a known retained build and clearing suspension through
`/routes/activate`, then make the same build active in Convex. Verify HTTP 200
and visually exercise the app. Do not delete R2 artifacts as part of moderation.

The global emergency switch is `SHARES_DISABLED=true` on apps-host. It disables
all app routes and is reserved for an incident, not routine moderation.

## Turn recovery

Each `BuildSession` stores its turn and sandbox ID in Durable Object storage and
sets a wall-clock alarm. Cancel and timeout both destroy the current sandbox,
write a terminal event best-effort, and become idempotent. Convex also rejects
events after the first terminal event and deduplicates `(turnId, seq)`.

For a stuck turn:

1. inspect Convex `agent_turns` and ordered `agent_events`;
2. inspect builder structured logs by `turnId`;
3. call the authenticated cancel path if the DO is still alive;
4. confirm the sandbox is destroyed and the turn is terminal;
5. retry as a new turn—never rewrite the old event stream.

## Observability and alerts

Both Workers have invocation logs enabled and emit JSON records with `service`,
`event`, and `timestamp`. Apps-host records request paths, missing assets,
suspended notices, manifest failures, and the kill switch. Builder records
request entry, turn start/completion/failure/timeout/cancel, and route changes.
Prompts, authorization headers, tokens, and secrets are never logged.

Use a short live tail during an incident:

```sh
bunx wrangler tail stella-v2-cloud-builder-dev --format pretty
bunx wrangler tail stella-v2-apps-host-dev --format pretty
```

The Convex cron `cloud app failure spike detection` runs every five minutes. It
opens a persistent `cloud_failure_alerts` row when at least three failed or
timed-out turns occur in 15 minutes, emits a structured error log, and resolves
the open alert once the window is healthy. Inspect recent rows with:

```sh
cd convex
bunx convex run cloud_apps:listFailureAlertsInternal '{}'
```

Production should route the structured Convex error event to the owner's alert
destination after cutover. The persisted row is the minimum reliable alert
source even when log delivery is delayed.

## Secrets

Cloudflare, R2, model, signing, and builder credentials live only in the v2
Convex environment or encrypted Worker secrets. Retrieve values into a pipe,
stdin, or ephemeral environment variable; never echo them, include them in
command arguments that will be retained, paste them into source, or expose them
to a sandbox/app bundle. Clear the macOS clipboard immediately after any
dashboard-created credential transfer.

The only sandbox credential is an opaque turn-scoped callback token. The
builder-to-Convex secret authenticates callbacks and route operations. Rotate a
secret by updating Convex and Worker secret stores, deploy both sides, exercise
health plus a real turn, then revoke the previous value.

## Release checklist

Before production:

- configure the production apps wildcard domain and DNS;
- create the v2 production Convex deployment and perform the controlled domain
  cutover;
- re-point Stripe webhooks and Better Auth/Apple sign-in URLs;
- confirm the Stripe plan-to-build quota mapping above;
- submit the existing-listing iOS and Android shell updates;
- obtain/verify the CarPlay entitlement and complete an on-head-unit
  dictation/cloud-reply/TTS pass;
- configure log-based paging from the persisted Convex failure alert;
- rotate the Apple sign-in private key and JWKS that appeared in a local
  planning transcript on 2026-07-12.
