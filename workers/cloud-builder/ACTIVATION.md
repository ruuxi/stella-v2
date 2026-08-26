# Cloud-canonical activation — diagnosis, design, and isolated staging

This document is the authoritative, code-grounded plan for making **normal
Stella v2 development conversations cloud-canonical** through the real product
runtime, reusing the merged `workers/cloud-builder`, runtime cloud dispatch,
journal/orchestrator, and Convex `cloud_apps` — **not** a parallel journal.

## Diagnosis (verified against the merged code)

The cloud merge preserved two separate paths:

1. **Cloud-agent path (already cloud-canonical).** `spawn_agent` into a cloud
   workspace is dispatched via Convex mutations over the signed-in user's JWT —
   `packages/runtime/kernel/runner/cloud-spawn-dispatch.ts`
   (`cloud_apps.spawnCloudAgentFromDesktop` / `continueMyCloudAgentFromDesktop`
   / `cancelMyCloudAgentThread`). The DO journal + orchestrator + container
   Sandbox live in `workers/cloud-builder` (`src/journal.ts`,
   `src/orchestrator-session.ts`, `src/conversation-hub.ts`). The
   user-authenticated conversation surface verifies a Convex Better-Auth RS256
   JWT (`src/auth-jwt.ts`, JWKS at `${STELLA_CONVEX_SITE_URL}/api/auth/convex/jwks`,
   `aud=convex`).

2. **Normal conversation path (intentionally local-canonical).** The ordinary
   desktop chat writes to the local SQLite session store
   (`packages/runtime/kernel/storage/session-store.ts`, 7,899 lines) →
   `~/.stella/stella.sqlite`. It never touches the DO journal.

**The real bug relative to Rahul's product goal** is therefore not a missing
toggle: normal conversations are local-canonical by design. Making them
cloud-canonical is a deliberate architecture change on path (2), reusing the
already-working machinery of path (1).

## Target architecture (no user-facing toggle)

- **Authority:** the `cloud-builder` conversation DO (SQLite journal in
  `src/journal.ts`) is canonical for identity, ordered events, lifecycle,
  child completions, retries/resume, compaction, cancellation, reconnect.
- **R2 segments:** rolled-over cold segments in `CONVERSATION_ARCHIVE`
  (`src/archive.ts`), oversize-row spills likewise.
- **Convex projection/discovery:** `cloud_apps` derives the monotonic
  cross-device conversation list; a clean client discovers + hydrates from it.
- **Execution placement:** automatic — an eligible desktop executes local tools
  and appends to the DO journal; otherwise the container Sandbox executes and
  appends to the *same* journal, under the existing claim/fencing/idempotency
  (`append_receipts`, `append_window`).
- **Local SQLite:** demoted to a rebuildable cache / offline-read materialized
  view of the DO journal. Never authoritative, never a silent fallback.
- **Fail-visible:** when cloud staging config is absent/unreachable, conversation
  creation must surface an explicit error (mirroring the existing
  `conversation_auth_unconfigured` path in `src/index.ts`) — never a silent
  local-canonical write.

### Runtime seam to change (path 2 → cloud-canonical)

`session-store.ts` conversation creation + append must, when cloud config is
present, mint/open the conversation through the same authenticated
conversation surface used by the cloud-agent path (the `x-stella-conversation-id`
surface in `cloud-builder/src/index.ts`), writing events to the DO journal and
mirroring into the local cache. This is a runtime change only — no UI change,
no mode picker.

## Isolated staging infrastructure

### 1. Worker (`wrangler.staging.jsonc`, added alongside this doc)

Isolated names so nothing collides with `stella-v2-cloud-builder-dev`:
`stella-v2-cloud-builder-staging`, fresh DO classes (new `new_sqlite_classes`
migration under a new worker name), isolated R2 buckets + KV.

Required per-environment secrets (set with `wrangler secret put`, never in Git):

- `BUILDER_SERVICE_SECRET` — shared Convex⇄worker service secret; must match the
  paired Convex deployment's env var of the same name.
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — S3 creds for the archive bucket.

Vars: `STELLA_CONVEX_SITE_URL` / `STELLA_CONVEX_CLOUD_URL` point at the paired
isolated Convex staging deployment.

Deploy: `bun run image:prepare && wrangler deploy -c wrangler.staging.jsonc`
(builds the real `cloudflare/sandbox:0.12.4`-based container image; Containers
run under the existing plan).

### 2. Convex staging (paired)

The worker verifies **real user JWTs** via the paired Convex deployment's
Better-Auth JWKS. A functional isolated Convex staging therefore requires the
full backend (`packages/backend/convex`: `auth.ts`, `betterAuth/`, `http.ts`,
`cloud_apps`, schema) deployed to a fresh deployment **with its external secret
set**: Better-Auth secret, the OAuth client id/secret for each sign-in provider,
Stripe keys used by billing, and `BUILDER_SERVICE_SECRET` matching the worker.
Without these a disposable dev user cannot sign in and no JWT can be minted, so
the authenticated conversation surface cannot be exercised.

## Status (updated — staging deployed)

**Infrastructure step 1 — DONE and verified.** The real `cloud-builder` is
deployed to isolated staging, paired with the existing **development** Convex
`flexible-panther-999` (authorized dev use; not production):

- Worker: `https://stella-v2-cloud-builder-staging.lolruuxi.workers.dev`
  (`wrangler.staging.jsonc`).
- Real container Sandbox images built + pushed to
  `registry.cloudflare.com/<account>/stella-v2-cloud-builder-staging-sandbox*`
  (standard-4 / standard-2), i.e. the actual cloud-execution container path.
- Bindings: 4 Durable Objects (incl. `OrchestratorSession` = the journal),
  isolated R2 (`stella-v2-*-staging`) incl. `CONVERSATION_ARCHIVE`, isolated KV.
- Secrets `BUILDER_SERVICE_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  set from the paired dev Convex (recovered via the authenticated CLI, uploaded
  as Worker secrets, never printed or committed).
- Verified live + **fail-visible**: the authenticated conversation surface
  returns `401 {"error":"Unauthorized."}` without a valid Convex JWT.

**Merge inconsistency fixed.** The cloud-builder image references
`packages/app-template` and `packages/apps-sdk`, which had been dropped from main
(a merge lost them) while the reference remained — so the container image could
not build from main. Both packages are restored from history (commit
`568018d7b`, an ancestor of main), and `image:prepare` + `wrangler --dry-run`
now succeed.

**Remaining work for the full signed-in Electron proof (step 2):**
1. Runtime seam: route normal dev conversations through the cloud-canonical
   conversation surface in `session-store.ts` (local SQLite demoted to cache,
   fail-visible on missing cloud config). Load-bearing — must be verified against
   the running staging stack.
2. Rebuild `stella-dev-harness` (scripts + worktrees are deleted/STALE) and seed
   a disposable signed-in profile via the Keychain-decrypt path, pointed at
   `flexible-panther-999` + the staging worker.
3. Drive two disposable Electron profiles: A create/send, B clean
   discover/hydrate/continue; prove desktop vs container execution into the same
   DO journal.

## Update 2 — activation wired; auth/routing proven; backend cloud_apps merge-drop found

Activation is now implemented in the product runtime (pushed):
- `desktop-ui/context/resolve-chat-storage-mode.ts` + `chat-store.tsx`: ordinary
  conversations are cloud-canonical when enabled + issuer-aligned; misconfig
  throws (no silent local fallback). `desktop-ui/.env.development` enables it for
  standard dev with the flexible-panther-999 issuer (production `.env` unchanged).
- `runtime/kernel/runner/cloud-builder-override.ts` (+ context.ts wiring,
  electron bootstrap `STELLA_PACKAGED` scrub, launch-electron-dev default):
  dev/harness-only staging cloud-builder origin override, production-isolated and
  fail-visible. 11 regression tests pass; typechecks + boundary clean.

Proven over the network against the deployed staging worker with a **disposable
anonymous** flexible-panther-999 identity (no 2FA):
- Anonymous sign-in works; its Convex JWT (`iss=flexible-panther-999.convex.site`,
  `aud=convex`, RS256) is ACCEPTED by the staging worker on the real journal
  route `POST /conversations/:id/local-turns/begin` (400 malformed-body, not 401;
  no-auth control = 401). This proves issuer alignment + JWKS verification +
  routing-to-staging end-to-end.
- `conversations:createConversation` via the Convex HTTP API with the disposable
  JWT succeeds (real conversation `_id`, correct `ownerId`).

**Open blocker for the actual DO append + Electron GUI proof (not 2FA):** a cloud
conversation must be registered in the cloud-owner registry that the worker
reads via Convex `GET /api/cloud/conversation-owner` (service-secret). That
registration — and the whole `cloud_apps` module (`getCloudRealtimeConfig`,
`spawnCloudAgentFromDesktop`, the registration writer) — is **absent from main's
backend source** (`packages/backend/convex`); it lives only on the older live
flexible-panther-999 deployment. Same merge-drop as `app-template`/`apps-sdk`.
Until `cloud_apps` is restored/reconciled into main and (re)deployed to the
paired dev Convex, neither a hand-rolled client nor the real Electron app built
from main can register a cloud conversation, so the journal append 404s
("Conversation not found"). Restoring + deploying it touches the shared dev
backend and so was left out of this turn.

## Update 3 — cloud-canonical journal PROVEN end-to-end (disposable identity)

`scripts/cloud-canonical-proof.mjs` proves the real path over the network against
the staging cloud-builder + development Convex `flexible-panther-999`, using a
**disposable anonymous** identity (no secrets, no 2FA, no shared user data).
**All checks pass:**
- `cloud_apps:createMyConversation` registers the cloud conversation owner.
- **Local-desktop execution → staging DO append**: `POST /local-turns/begin` +
  `finish` append the user + assistant records; `GET /history` returns
  `["user","assistant"]` from the DO journal.
- **Automatic Convex projection/discovery**: `listMyConversations` finds it.
- **Clean-client hydration**: a brand-new client with ZERO local cache hydrates
  the full transcript from the cloud and continues (t2); the journal spans both
  turns `["user","assistant","user","assistant"]`.
- **Cache-loss survival**: a fresh no-cache client re-reads canonical history —
  authority is the DO journal, never local SQLite.
- **Cloud-Container placement**: `spawnCloudAgentFromDesktop` is accepted by the
  real backend (returns a `threadId`), proving the cloud-sandbox dispatch path is
  reachable end-to-end. Full container *model* execution did not append in-window
  because a disposable anonymous identity has no LLM entitlement — a credential
  limit of the throwaway user, not a wiring gap.
- **No silent local fallback**: enforced + unit-tested by
  `desktop-ui/context/resolve-chat-storage-mode.ts` (issuer mismatch / missing
  config throw).

## Remaining (honest): the actual Electron GUI + source restoration

The **product cloud feature is stripped from main**, not merely activation-gated:
`packages/backend/convex/cloud_apps.ts` (~5,671 lines in `stella-cloud`), its
`http_routes/cloud_apps.ts`, and the desktop-ui cloud client
(`packages/desktop-ui/src/features/cloud/*`) are all **absent from main** (present
on the older live `flexible-panther-999` deployment and in the `stella-cloud`
reference). The proof above therefore exercises the real deployed backend +
worker protocol directly (the exact contract the app uses), rather than the
Electron UI — which cannot be built from main source until `cloud_apps` +
the desktop-ui cloud client are restored and reconciled with v2's evolved
contracts (Effect runtime, auth/provider, device routing, removed
`device_presence`). That reconciliation is a large multi-file port; a partial
restore would break main's backend typecheck/deploy, and an all-or-nothing
`convex deploy` of it to the shared `flexible-panther-999` risks the working dev
backend the proof depends on — so it is intentionally not done blind here.

---

The redundant standalone `workers/journal-realstaging` proof worker was removed;
its journal invariants (gapless seq, idempotent receipts, fencing, R2 rollover)
are already covered by the real implementation in `src/journal.ts` and
`tests/journal-append-*.test.ts`.
