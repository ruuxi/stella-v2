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

`stella-v2-cloud-builder-dev` is the authenticated execution plane, with two
Durable Object classes:

- An `OrchestratorSession` DO per conversation runs the cloud orchestrator —
  the real `packages/runtime` agent-core loop, delegation-only, no sandbox
  ever. Every plain-chat turn costs tokens only. Its tool set is pinned in
  code (`spawn_agent`, `send_input`, `pause_agent`, `web`); model calls go
  through the managed relay authenticated by the per-turn token, so plan
  gating and metering bill the owner with no new billing code.
- A `BuildSession` DO owns sandbox turns. Legacy app-build turns keep the
  M0–M6 pipeline. `kind: "agent"` turns run a spawned general agent: restore
  the workspace checkpoint, run the real runtime headless via
  `executor-cloud --agent-turn` (pinned tool list: exec_command, write_stdin,
  node_repl, apply_patch, web, view_image), checkpoint, report. Sandboxes
  receive a short-lived turn token, never provider or account credentials.

## Cloud chat (orchestrator plane)

`startCloudChat` routes by target: an app with registered operations enters
the ops lane, an explicit/inferred app target or a "make/build/create an app"
prompt enters the legacy build lane, and **everything else is plain chat** —
a `kind: "chat"` turn dispatched to
`POST /conversations/:conversationId/turns` on the builder.

**The conversation transcript is the one exception to "Convex is the
database".** It lives in the conversation's `OrchestratorSession` Durable
Object, in that object's SQLite, as a single ordered `journal` (one gapless
`seq` covering messages, turn lifecycle records, and UI cards). The DO is
already one per conversation, so desktop and phone writing to the same
conversation are serialized by construction rather than by discipline, and the
per-turn HTTP round trip to reload history is gone. Clients read the journal
over a hibernatable WebSocket at
`GET /conversations/:conversationId/socket`, authenticated by the user's Better
Auth JWT (verified in the worker, before the DO is addressed). Turn *starts*
never touch the socket — they stay on `startCloudChat` so quota, engine
resolution, and turn-token minting cannot be bypassed. Older journal rows roll
into gzipped R2 segments in `CONVERSATION_ARCHIVE`, with the DO holding the
manifest.

Convex keeps two DERIVED projections of that transcript. Both are written only
by the DO, fenced on `(epoch, lastSeq)`, and regenerable from it — nothing in
Convex may read a DO-owned field and act on it as truth:

- `cloud_conversations` — the conversation index (id, owner, title,
  `updatedAt`, last-message preview). A per-conversation DO cannot answer "list
  my conversations", so this slice stays relational. `{conversationId, ownerId,
  createdAt}` is Convex-authoritative and DO-mirrored; the rest is projection.
- `cloud_message_excerpts` — one compact, full-text-indexed row per turn,
  backing cross-conversation Recall. An index, not a second copy of truth.

Everything else is canonically Convex, as before:

- `cloud_thread_messages` — spawned-agent **thread** transcripts only
  (`conversationId = threadId`), read back by `BuildSession` for `send_input`
  continuations over `GET /api/cloud/context`. Private job state, not
  conversation content: nothing subscribes to it, so the reactive-fan-out
  argument that moved the conversation does not apply here. Both HTTP routes
  refuse anything that is not a `kind: "agent"` turn's own thread.
- `cloud_turn_tokens` — SHA-256 hashes of per-turn tokens (30-minute TTL,
  purged by cron). The raw token authenticates (a) relay model calls via the
  `x-stella-turn-token` header (the relay resolves it to the owner and bills
  them — `stella_provider/authorization.ts`), and (b) `/api/cloud/events`,
  `/api/cloud/messages`, `/api/cloud/threads/complete`, and
  `/api/cloud/web-search`, scoped to the token's turn.
- `cloud_agent_threads` — one row per spawned agent. On terminal state,
  `completeAgentThreadInternal` wakes the orchestrator with a **visible**
  `lane: "wake"` turn carrying the agent's report as a lifecycle message.
  The wake turn is the only place the orchestrator's relay of the result
  exists, so the UI renders it (assistant side only — its prompt is
  lifecycle plumbing, and `CloudChatTail` skips the user bubble for lane
  `"wake"`); spawned-agent turns themselves stay `hidden`. Thread status is
  also the concurrency source of truth: `spawnCloudAgentInternal` counts
  running threads against the plan's concurrent-agent quota and rejects a
  spawn into a workspace that already has a running agent — checkpoints are
  last-writer-wins per (owner, workspace), so same-workspace concurrency
  would silently lose work.

Spawn placement is the `workspace` argument (`cloud`, `computer`,
`project:<name>`, `stella`, `app:<slug>`). `computer` is the one local
placement and is available only when the desktop orchestrator can reach the
machine. Every other explicit workspace runs in Stella's cloud. A desktop
spawn records its origin device and conversation; a device-scoped lifecycle
subscription persists the terminal report into the local orchestrator thread
before acknowledging it, so a cloud child can finish while the desktop is
closed and still report after restart. Running cloud rows are not replayed into
the local activity feed because Convex already projects that activity.
Workspace persistence is a Sandbox backup per (owner, workspace) whose
descriptor lives in KV under `ws:<sha256(owner:workspace)>` — sandbox disk is
a cache, the checkpoint is truth. The owner fence serializes primary agents in
the same canonical workspace while unrelated workspaces remain parallel.
Checkpoint rotation records cleanup debt before changing the pointer, deletes
failed-attempt and superseded backup bytes, and surfaces cleanup/checkpoint
failure rather than silently reporting completion. Chat-turn events stream with
`seq: "auto"` (Convex assigns max+1); build-lane turns keep explicit DO-side
seqs, but **terminal** cancel/timeout events always use `seq: "auto"` —
fixed sentinels collide with auto-seq streams and Convex would drop the
terminal patch. Idempotency comes from Convex rejecting events after the
first terminal one.

Operational contracts (hardened 2026-07-24 after adversarial review):

- **Async dispatch.** Chat and agent turns are accepted with `202` and run
  detached in the DO. Convex's dispatch action only fails a turn when the
  dispatch itself fails; outcomes travel exclusively through event/thread
  callbacks, so a mid-turn transport blip can no longer mark a running turn
  failed and swallow its result. Accepted turns are durable before the 202:
  BuildSession persists turn + watchdog alarm first; OrchestratorSession
  persists queued turns under `queued:*` (its constructor re-enqueues them
  after an isolate restart, an alarm is always pending as the wake signal,
  and a turn interrupted mid-run gets a failed terminal on recovery). The
  detached agent turn fences every shared-state mutation on stored-turnId
  ownership, so a stale unwind can never fail a successor's thread, kill its
  alarm, or wipe its state.
- **Watchdogs abort — and terminal delivery retries.** Both DO alarms mark
  the turn terminal *and* abort the in-flight loop / destroy the sandbox —
  no post-timeout token burn (the orchestrator also re-checks the terminal
  flag right before starting the loop, covering an alarm that fires during
  setup). Terminal event + thread completion are retried via re-armed alarms
  (5×30 s) rather than fired once and forgotten, with a reconcile pass so
  the timeout backstop never races a turn that completed in the same
  instant; cancel paths arm the same retry on delivery failure, and the
  spawn gate ignores running threads older than 1 h as a bounded-lockout
  backstop.
- **Context budget.** Both loops prune loaded history to a ~48k-token newest
  window cut at a `user`-message boundary
  (`@stella/executor-cloud/prune-history`), so a long conversation degrades
  gracefully instead of bricking on context overflow. Real compaction stays
  a named seam.
- **Transcript writes are lane-scoped.** A turn token appends only to its
  own transcript: spawned-agent turns to their thread
  (`conversationId = threadId`), orchestrator turns to their conversation —
  a sandbox can never forge rows into the parent user conversation. The same
  binding applies to `/api/cloud/threads/complete`: a token completes only
  the thread its turn belongs to. Appends are batched ≤ 50 rows per request
  on both writers, each batch retried once (multi-batch persist is retried,
  not transactional).
- **Relay model pin.** Turn-token-authenticated relay requests may pin
  exactly the ids in `CLOUD_EXECUTOR_PINNED_MODEL_IDS`
  (`convex/agent/model.ts`) for every audience — free/go included — because
  the pin comes from platform code and the executor's anthropic-messages
  adapter cannot follow an audience coercion; limits and metering still
  bill the owner.
- **Quota lanes.** Build-lane daily/concurrency gates count only lanes
  `build`/`auto`/legacy-unset, read through the per-lane index
  `by_ownerId_and_lane_and_createdAt` (a mixed-lane window is defeatable:
  chat rows outnumber builds up to 20× and crowd them out of any fixed
  `take()`); chat, wake, and agent turns draw from their own budgets.
  Metering: the pinned executor model is listed in
  `ADDITIONAL_MANAGED_MODEL_IDS` so price sync covers it, and the turn token
  is stripped from headers forwarded upstream.

### Orchestrator parity with desktop (2026-07-27)

The cloud orchestrator runs the same loop *configuration* as the desktop
runtime, not just the same loop:

- **Persona.** The DO builds its system prompt from the canonical
  `agents/orchestrator.md` body served by `/api/stella/prompts` (ETag-cached
  in DO storage, refreshed ≤ every 5 min), plus a cloud overlay
  (`cloud-prompt.ts`) that overrides only what is physically different:
  tool surface, no local machine, app/Stella apply semantics, no local file
  links. A cold DO that cannot reach Convex degrades to the compact fallback
  prompt. Personality: the user's `PERSONALITY.md` from their R2 agent home
  when present (nothing syncs it yet — the slot exists), else the canonical
  `prompts/personality-stella.md`, injected with desktop's `startup_doc`
  framing. Reply language: the composer sends the UI locale; the DO persists
  it per conversation and injects desktop's locale directive.
- **Loop config.** `thinkingLevel` resolves from the model's reasoning flag
  exactly as desktop does (medium on reasoning models); desktop's
  `transformContext` re-prunes and strips stale images before every provider
  call; `degenerateResponseRetries: 0` + `providerRequestLimit` match
  desktop because the outer ladder owns retries.
- **Transient retry ladder.** Both cloud loops (DO + sandbox executor) wrap
  the loop in desktop's `executeAgentRunWithRetry` — 4 attempts over
  retryable provider/transport/empty-completion failures, resuming the same
  in-memory context after popping the errored tail. The DO wires the ladder's
  abort signal to its cancel/timeout paths so a terminal turn never retries;
  the watchdog contract is unchanged (full backoff adds ~10 s worst case).
- **`web` tool.** The DO exposes the desktop tool's exact surface
  (`kernel/tools/defs/web-def.ts`) and fetch pipeline
  (`kernel/tools/web-fetch-core.ts`): readable-text extraction, manual
  redirects with per-hop SSRF re-validation through the shared guard
  (`kernel/tools/url-guard.ts` — literal + encoded IPv4, IPv4-mapped/NAT64
  IPv6, private/CGNAT/link-local/reserved ranges). Desktop adds a DNS
  resolution check on top; workerd has no resolver hook and leans on
  platform egress policy for rebinding names.
- **Attachments.** Drive images attached in the composer ride the turn as
  real image blocks: `startCloudChat` carries drive paths (≤ 4), the DO
  hydrates them via the turn-token-scoped `/api/cloud/drive/attachments`
  route (images only, ≤ 3 MB each, 120 s signed GETs) and passes them to the
  prompt. The prompt text still names the paths, so later turns reach the
  files through the drive.
- **Deliberately absent tools** (each blocked on a concrete constraint, listed
  in the DO tool catalog and the persona overlay): `Read`, `html`,
  `image_gen`, `view_image`, `map`, `tool_search`, `spawn_manager`.

### Cloud engines (user subscriptions)

Desktop's engine choice (Stella runtime / Claude Code / Codex, backed by
keychain-stored OAuth tokens) now has a cloud counterpart. Credentials live
in `cloud_llm_credentials` — AES-256-GCM encrypted with the server-held
`CLOUD_LLM_CREDENTIALS_KEY` env var — and are the durable login that
survives across sandbox instances. Tokens are never returned to clients,
never enter a DO or sandbox, and refresh server-side (`cloud_engines.ts`
`resolveEngineAccess`, called by the relay, persists rotated tokens).

- **Connect (web-friendly, paste-based):** `startEngineConnect` mints PKCE
  server-side and returns only the authorize URL; the user approves in their
  browser and pastes the code (Claude) or the full localhost redirect URL
  (ChatGPT — the page won't load, the address bar still carries the code)
  into `finishEngineConnect`, which exchanges and stores it. UI:
  `CloudEnginesCard` on the Settings → Account tab (works in the web/mobile
  interior — no Electron needed).
- **Selection:** per-owner `cloud_engine_settings.chatEngine`
  (`stella` | `anthropic`), resolved once at dispatch
  (`resolveOwnerEngine` in `cloud_apps.ts`) for chat, wake, and agent
  turns; the cloud `spawn_agent` also takes a per-spawn
  `model: "claude" | "claude/<model>"` override, validated at spawn time
  with readable errors when no credential is connected.
- **Relay user-credential mode:** the DO/executor adds
  `x-stella-llm-credential: anthropic` (flag only) next to the turn token;
  the relay resolves the owner's stored token, forwards with Bearer auth
  plus the Claude Code identity headers/system block Anthropic requires for
  subscription tokens, and **skips managed gating and metering** — the
  spend is the user's subscription. The header is stripped before any
  upstream forward on the managed path.
- **Honest limits:** `openai-codex` credentials can be connected and stored
  (login persistence is ready), but Codex-backed cloud turns and the actual
  external CLI harnesses (Claude Code / Codex binaries in the sandbox image,
  brokered via the outbound proxy) are named follow-ups — selection is
  refused with readable errors until then.

Engine dev probes: `cloud_engines:connectProbeInternal` (key + authorize URL
construction), `seedEngineProbeInternal` / `resolveEngineProbeInternal` /
`clearEngineProbeInternal` (fake-credential pipeline exercise; booleans only,
never token material).

Dev probes (no signed-in client needed):

```sh
cd convex
bunx convex run cloud_apps:startChatProbeInternal '{"prompt":"...","ownerId":"<owner tokenIdentifier>"}'
bunx convex run cloud_apps:getTurnProbeInternal '{"turnId":"<turnId>"}'
```

Verified 2026-07-24 end to end on dev (post-hardening): plain chat replies
in ~2.3 s for a **free-audience** owner (pinned relay model honored); a
spawn turn wrote a drive file, checkpointed, and woke the orchestrator with
a **visible** wake turn carrying the relay; a 75 s agent turn completed
through the detached 202 dispatch; a concurrent same-workspace spawn and a
continuation into a running thread were both rejected with the readable
errors above.

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

### Stella interior self-modification

The packaged desktop is now a stable shell; Stella's renderer is a separately
versioned artifact. A cloud child spawned with `workspace: "stella"` restores
the owner's long-lived renderer source checkpoint, edits the existing source,
and runs the pinned production Vite builder. The builder requires all four
entry documents (`index.html`, `mini.html`, `overlay.html`, `pet.html`),
injects the canonical renderer CSP before hashing, validates bounded paths,
symlinks, counts, and sizes, then uploads files under the immutable R2 prefix
`interiors/<ownerHash>/<buildId>/`. Convex independently verifies the callback
manifest and records a candidate; it never auto-selects one.

The user selects or rolls back candidates in Settings. The mutable Convex row
is only a compare-and-swap pointer (`activeBuildId`, `previousBuildId`,
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
candidate is selected. The renderer then establishes its own Better Auth
browser session; the capability selects presentation, not account authority.

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
- rollover on the route itself. `afterTerminal` used to be its only trigger, so
  a conversation written only through this route (or `/cards`) never evaluated
  `HOT_MAX_ROWS`.

All three live in `workers/cloud-builder/src/conversation-types.ts`. Making the
ceiling a per-plan number is the open product decision — the enforcement point
is one constant, but what Free may mirror is not an engineering call.

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

Before deploying the apps host, configure its `BUILDER_SERVICE_SECRET` to the
same service credential used by the Convex interior-route HTTP endpoint. The
stable `/stella/<stableRouteId>/` surface fails closed with 503 when that
credential is absent.

Publish an interior by building the renderer with `NODE_ENV=production` set
explicitly (a leaked `NODE_ENV=development` makes Vite emit a dev-flagged
bundle), zipping the dist as `interior-bundle.zip`, then running
`workers/apps-host/scripts/publish-interior.mjs <dist> <new-prefix>` with the
R2 credentials piped from Convex, and atomically replacing
`app:stella-interior` in KV. Never overwrite an existing prefix. The manifest
endpoint must return the new prefix before mobile rollout.

Framing contract: the interior worker's CSP must carry
`frame-src <apps host origin>` (via `EMBED_APPS_ORIGIN`) and the apps host's
`frame-ancestors` must include the interior origin, or embedded apps silently
render as a blocked frame.

## Activation and rollback

Every finished app build activates immediately — first build or update alike.
An app is live when its build completes; the chat card's action is "Open app",
not "Apply". There is no pending state for apps to sit in.

Activation is the same three steps whether it runs automatically at build
completion or from a rollback:

1. validate ownership of app and build in Convex;
2. write the new KV route through builder `/routes/activate`;
3. atomically mark the build active in Convex.

Rollback points that operation at any of the five retained builds, and is the
one user-initiated case. Do not copy artifacts or mutate an existing prefix.
Confirm the deployed URL returns 200 and the expected UI, then confirm
Convex's `activeBuildId`.

Stella's own interior is the exception: its build does not switch any client on
its own. The Settings card selects the immutable candidate through Convex CAS.
The standalone web capability resolves that pointer on each request. Each
packaged desktop independently downloads and verifies the candidate, runs its
four-surface readiness trial, and only then records it as locally healthy.
Selecting “Use packaged” clears the active pointer; the same stable web URL
falls back to the published default interior. A rejected desktop candidate
requests a control-plane rollback and remains quarantined locally.

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

1. inspect Convex `agent_turns` and ordered `agent_events`. For a **chat**
   turn the transcript is not in Convex — read the DO's journal directly with
   the dev probe (`GET /conversations/:id/journal?limit=&beforeSeq=`, service
   secret, or `cloud_apps:getConversationProbeInternal`). There are no tests by
   owner decision, so this probe is the verification tool: it also reports
   `headSeq`, `indexSyncedSeq`, `pendingExcerpts` (turns still owed to the
   Convex search projection), hot-tier stats, inbox depth, `databaseBytes`,
   `storedBytes` (resident plus archived — what the per-conversation ceiling
   is measured against), `spillObjects`, purge-queue depth, and the object's
   wake state — `alarmAt`, the turn ids still durable under `queued:`, and
   `sealed`. The invariant to check there: an accepted turn always has a
   pending alarm, so `queued` non-empty with `alarmAt: null` is a stranded
   turn that nothing will ever wake;
2. inspect builder structured logs by `turnId`;
3. call the authenticated cancel path if the DO is still alive;
4. confirm the sandbox is destroyed and the turn is terminal;
5. retry as a new turn—never rewrite the old event stream.

## Search projection and conversation deletion

`cloud_message_excerpts` is derived and regenerable. To rebuild it for one
conversation, POST `/conversations/:id/reindex` (service secret). It replays
**every** turn excerpt from the DO's own `turn_excerpts` mirror, in batches, and
its status is the answer: `200 {complete:true}` means the projection is whole,
`202 {complete:false, pendingExcerpts:N}` means the call ran out of budget with
`N` turns still owed — run it again. A lagging projection also drains itself at
every turn end and every socket connect, so a live conversation converges
without an operator.

Per-conversation deletion is a two-party handshake and the DO's **body** is the
verdict, not its status. `POST /conversations/:id/purge` answers `202
{purged:false, pending:N}` when it could not delete `N` R2 objects; in that case
it deliberately keeps its SQLite — the segment manifest is the only record of
those keys — and Convex leaves `purgedAt` unset so `sweepDeletedConversations`
retries. Account deletion's durable gate stays open for the same reason. If a
conversation is stuck unpurged, check builder logs for
`conversation_purge_delete_failed` before assuming Convex is at fault.

A finished purge leaves a row in `cloud_conversation_tombstones`, and it is the
fence that keeps the deletion permanent: an index flush that a resident DO
started before the purge can land minutes later, and without the fence
`upsertConversationIndexInternal` would treat the missing row as a lost one and
rebuild it — with the conversation's transcript excerpts — from the DO's own
`meta`. It cannot be the index row itself, because account deletion has to
delete that row: it carries `ownerId`. The tombstone carries a random
conversation UUID and the instant the DO confirmed its storage was gone,
nothing else, so it survives the owner without retaining anything about them;
`sweepConversationTombstonesInternal` retires it after 30 days, far beyond the
lifetime of any in-flight flush. A refused flush answers `{accepted:false,
excerptsAccepted:false, reason:"purged"}`, and the DO seals itself on that
reply (`conversation_sealed_after_purge`) rather than retrying.

## Operations layer (two-speed agents)

Mini apps expose two agent lanes over one document of state. The build lane is
the existing source-edit → sandbox → immutable artifact → apply-card path. The
operations lane lets the agent act as a *user* of the running app: the app
declares named, deterministic operations, the model only picks a verb and
arguments, and ordinary in-app code applies the change. The app's own UI
controls and the agent invoke the same functions — one implementation, no
separate AI path.

### App-side convention

The template ships `src/operations.ts`: deterministic functions over the app's
state store with in-app argument validation, plus `createAppOperations`, which
binds those functions to SDK operation definitions. UI controls call the same
functions directly. Durable state lives in `stella.storage` (the app persists
its state document after every mutation and hydrates it on load); operations
mutate the live in-memory state and render immediately.

Apps register operations through the SDK only:

```ts
await stella.operations.register([
  { name: "set-habit-progress", description: "…",
    args: [{ name: "habit", type: "string", required: true },
           { name: "progress", type: "number", required: true }],
    handler: (args) => fns.setHabitProgress(args) },
]);
```

`register` publishes a manifest (names, argument descriptors, descriptions —
never handlers) to Convex and starts listening for invocations. Apps never see
Convex directly; the SDK remains the only boundary. Manifest writes are
accepted only from owner sessions and are capped: at most 20 operations, 8
arguments each, kebab-case names ≤ 64 chars, descriptions ≤ 200 chars, 8 KB of
manifest JSON.

### Data model

- `cloud_app_operations` — one row per app: the current manifest JSON and its
  size, replaced idempotently on registration.
- `cloud_app_op_invocations` — one row per agent invocation: `invocationId`,
  `appId`, `ownerId`, `turnId`, `name`, `argsJson`, `status`
  (`pending → delivered → completed | failed`, or `expired`), result/error and
  timestamps.
- `agent_turns.lane` — `"build"`, `"operation"`, or `"auto"` while routing.
  Turn records stay executor-agnostic: the lane names the dispatch path, and
  everything the agent did is visible as ordered `agent_events`.

### Turn routing

`startCloudChat` keeps the build path unchanged for new apps and for apps
without a manifest. When the target app is active and has registered
operations, the mutation records the turn with `lane: "auto"` and schedules
`routeCloudTurnInternal` instead of dispatching the builder directly. The
router makes one small model call (Claude Haiku, JSON-only) with the user
request and the manifest, instructed to prefer operating the running app and
to choose `build` only for structural/code/visual changes. Then:

- **operation** — validate the verb against the manifest, write the
  invocation row, log an `op_selected` turn event, and schedule a 20-second
  expiry. No sandbox, no build, no apply card; the executor is never involved.
- **build** — re-check the plan's build quota (op turns never reserve build
  quota up front), set `lane: "build"`, and dispatch the existing builder
  path. Quota failures terminalize the turn with the standard readable
  message.

Completion is reported by the platform surface that delivered the invocation:
a `completed` (or `failed`) terminal event carries the operation name,
arguments, and the app-returned result, so the chat timeline shows exactly
what the agent did.

### Live reach

Delivery targets a running instance the owner has open:

- **In-shell (iframe bridge)** — the app page subscribes to pending
  invocations for its app, claims each one atomically (`pending → delivered`,
  so two open tabs never double-fire), forwards it to the iframe over
  `postMessage` with the existing origin checks, and reports the app's result
  back to Convex. The SDK validates arguments against the registered
  definition in-app before running the handler.
- **Standalone (HTTP)** — the SDK polls `/api/apps/operations/poll` with its
  app-session token while the page is visible. Only sessions whose user is the
  app owner are eligible; anonymous sessions are told once and never poll.

If no eligible instance claims the invocation before expiry, the turn fails
gracefully within ~20 seconds: "Open the app, then ask again." No queueing in
v1 — rejected invocations are never executed later against stale intent.

### Safety and quotas

Operations are app-defined untrusted code and run only inside the app's own
origin-isolated instance; the platform never executes them. Argument validation
lives in-app (SDK schema check plus the operation's own semantic checks). The
platform enforces: owner-only routing and delivery, origin/session verification
on every transport (unchanged from M3), manifest and argument size caps (8 KB),
result caps (8 KB), and plan-scaled limits consistent with M6 — op turns draw
from their own budgets (`burstStarts × 5` per 10 minutes, `dailyTurns × 20` per
rolling 24 hours) so a chatty operator lane can never starve or bypass build
quotas. No new secret paths: invocations carry only the verb and JSON
arguments; results carry only app-returned JSON.

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
