# Stella v3 and the all-Cloudflare backend

Started 2026-10-01. Two tracks:
- **v3:** the app modifies itself from source, behind native launchers.
- **Cloudflare:** delete Convex and run the whole backend on Cloudflare.

The Rust runtime port is paused, and v3 runs the TypeScript runtime under Bun. There are no users, so nothing is migrated; replaced code is deleted.

## Starting point

- **Convex:**
  - About 143K non-test lines, 176 tables, 36 crons and about 110 HTTP routes.
  - Clients call about 110 distinct public functions and hold about 35 live queries.
  - Only cloud-builder, model-gateway and telemetry call it.
- **v1:** the self-modifying version, in `~/workspaces/old-stella/{stella,stella-launcher}`. Its Tauri launcher runs `bun run electron:dev` from a git clone.
  - It holds back agent edits with a Vite plugin until the user clicks Update.
  - Undo uses `git revert`, and upstream updates are merges, with an install-update agent that resolves conflicts.
  - On macOS, Electron is renamed to `Stella.app`, given an ad-hoc signature, and launched via `disclaim-spawn`.
- **v2:** a packaged Electron app built with electron-builder.
  - The runtime is a detached Bun worker. The runtime host and UI state live in Electron main.
  - Plugin-style apps come from `apps-sdk` and `create-stella-app`.

## Track A: Cloudflare

### Target

One backend worker, `workers/cloud-builder`, gives clients a single origin. The model gateway stays a separate worker.

| Concern | Home |
|---|---|
| Identity | Better Auth on D1 at `/api/auth/*`, using its built-in D1 dialect. The `jwt` plugin signs RS256 tokens with issuer = backend origin and audience `stella`. The owner id is the user id. |
| Per-owner data | `OwnerGate`'s SQLite becomes the owner's database: plan and billing, usage, devices and pairing, preferences, schedules, drive, media jobs, integrations, memory and skill metadata, engines and secrets, projects, browser and connect requests, and the conversation and agent-thread index. Nothing is mirrored as a snapshot. |
| Global data | D1: auth tables, routing indexes, catalogs, abuse signals and feedback. The routing indexes map Stripe customers, fal requests, pairing codes, TTS tickets, share slugs, OAuth state and GitHub installations to an owner. The catalogs cover prompts, prices, integrations, emoji and releases. |
| Client calls | `POST /api/rpc/<fn>`. Owner-scoped functions run inside the owner object. Types live in `packages/contracts`. |
| Live state | The `/owners/me/live` socket carries named views. After each write, the object reruns the open views and pushes any that changed. |
| Background work | A per-owner `jobs` table driven by one alarm, plus Cron Triggers for global sweeps. |
| Analytics and admin | Owner objects send events to a Basin Pipeline, and Basin SQL serves cross-owner queries. |
| App source (v3) | Cloudflare Artifacts: an upstream app repo with one fork per user. The backend creates forks and issues tokens. |

**Deleted rather than ported:**
- The anonymous-to-account transfer. An anonymous account is upgraded in place, keeping its id.
- The Stripe crash-consistency ledger.
- The legacy Convex chat runtime and remote turns.
- The turn-outbox projection, owner-snapshot pushes, and the service-secret callbacks.

### Phases

Each phase ends with tests green and its Convex modules deleted. Identity moves last: workers already verify the Convex-issued JWT, so every data domain can move first, and the final step swaps the issuer, makes the owner id the plain user id, and deletes Convex in one go without rewriting Convex's auth in between.

1. **Owner platform** (done 2026-10-01, `96cb929cd`): `POST /api/rpc/<name>`, the `/owners/me/live` view socket, `owner_jobs` on the gate alarm, `@stella/contracts/backend` client. D1 and the Basin sink arrive with the first domain that needs them.
2. **Turn-plane index** (done 2026-10-01, `e889cd1f4`, `391866409`, `368904096`). Conversations, agent threads, desktop-dispatched agents, computer-thread records, and fork/rewind now run in the owner object, and every client calls them there. Convex's client-facing conversation, agent-thread and edit API is deleted.
   - The outbox still projects into Convex (`cloud_conversations`, `agent_turns`, `cloud_agent_threads`, `cloud_dispatches`). It is the only way the remaining Convex readers learn about turns, and Convex must not call into per-owner objects (that would place them by the Convex region). Readers: billing and the integration lease (phase 3, both fail open without rows); placement (4); purge and drive's turn identity (5); browser interactions and the project-delete guard (7). The projection and `cloud_outbox` go once the last of them has moved.
   - The stale live acceptance drivers are deleted (`56cbce5f2`). Changes are verified in the running product instead.
3. **Billing and gateway control.** Shape (2026-10-01):
   - **Owner object `billing` domain.** It holds the plan and Stripe ids, the usage windows (rolling, weekly, monthly, lifetime), credits, session grants and usage receipts. Plan limits come from the worker's environment, under the same variable names Convex used.
   - **Client calls.** Clients use `billing.status` (live), `billing.checkout`, `billing.creditCheckout` and `billing.portal`.
   - **Stripe.**
     - `POST /api/stripe/webhook` on cloud-builder finds the owner from `metadata.ownerId`, which is set on the customer, the subscription and the payment.
     - Each subscription event refetches the subscription, so delivery order doesn't matter. Event ids are deduped per owner.
     - There is no crash-consistency ledger.
   - **Session capabilities.**
     - The gateway asks cloud-builder over a service binding, with the same request and response as before.
     - The owner object reserves the budget chunk as a grant, and cloud-builder signs the capability.
     - Abuse admission stays in Convex until phase 9, as `POST /api/gateway/session-admission`. It covers Turnstile, sybil pressure, origins, the anonymous device chunk and suspension, and the owner object calls it with a `paying` flag.
   - **Usage.** The gateway's usage consumer sends each batch to cloud-builder, which settles it into the owner object. It also sends the batch to Convex, but only for abuse accounting (risk signals and the anonymous IP allowance), until phase 9.
   - **Turn budgets.** `OwnerGate.snapshot()` takes the plan and allowance from its own billing tables. Convex's snapshot no longer carries them.
   - **Convex code that still spends money** (web search, media, music, voice, dictation, emoji packs) uses `lib/billing_bridge.ts` until its own phase moves it.
     - The bridge calls `access` and `usage` on cloud-builder's `/internal/billing/*` with the builder service secret. These owners are active clients, so their objects already exist.
     - Voice's realtime lease logic moves out of `billing.ts` and reads its budget through the bridge. Reservations are dropped.
   - **The "paying" identity rung.** The owner object pushes a one-bit flag to Convex whenever it changes. It goes with identity in phase 10.
   - **Not in this phase.** Engine access moves with integrations (7), owner enforcement with abuse (9), and model prices with the catalog (8).
4. **Devices.** Mobile pairing, push, tunnels, execution placement.
5. **Owner data.** Cloud home (memory and skills), drive, schedules, preferences, feedback, reset and purge.
6. **Media and voice.** Media, voice/TTS, dictation, music.
7. **Integrations.** Composio, native OAuth, X, GitHub projects, engines and secrets, browser interactions, connector connect.
8. **Public content.** Canvas shares, emoji packs, prompts, model catalog and prices, releases, Fashion, the X bot.
9. **Abuse and admin.** Abuse, integrity, risk, admin, test accounts.
10. **Identity, then delete Convex.** Better Auth on D1 with the handoff routes; the owner id becomes the user id; delete `packages/backend/convex` and the Convex dependencies.

## Track B: v3

The design comes from the 2026-09-30 session "Stella repository versions", with the 2026-10-01 decisions applied: native launchers, auto-apply, Artifacts for source, and plugin apps folded in.

1. **The runtime becomes the app's sibling.**
   - Move the runtime host and canonical UI state out of Electron main into the runtime process.
   - Electron becomes a client that can restart without losing anything.
   - Shape (2026-10-01):
     - The detached Bun worker process becomes "the runtime". It runs the worker server and `StellaRuntimeHost` together; the host reaches the worker through an in-memory JSON-RPC pair.
     - The runtime socket now speaks a client protocol: attach, call a host method, host events, and host callbacks (secrets via `safeStorage`, prompts, notifications, windows) served by the attached client. A callback waits up to 30s for a client during an Electron restart.
     - Electron's `RuntimeHostAdapter` wraps a `RemoteRuntimeHost` that spawns or reattaches the runtime and reconnects on loss.
     - Restarting the runtime (a code update, the dev watcher, or the "restart runtime" action) means the runtime exits when idle and the client respawns it. The native launcher takes the spawning over later.
     - UI state stays in Electron (decided while building it). `ui-state.json` is on disk and flushed on quit, the renderer restores its conversation tabs from it, and `UiStateService` holds only transient session fields. Moving it would put spawning the runtime on the first-paint path and add a mirror for preload's synchronous reads, without fixing any loss.
     - Auth minting, `safeStorage`, windows and the phone bridge stay in Electron for now. Auth moves with Cloudflare phase 10.
2. **Run from source.**
   - The renderer is served through an Electron protocol handler (`stella-app://desktop`): oxc transforms each file on request, and results are cached by content hash.
   - Rolldown pre-bundles dependencies when the lockfile changes, and Tailwind and the route tree regenerate incrementally.
   - The runtime and its CLIs are Bun running `packages/runtime` TypeScript. A runtime source edit restarts the runtime when idle; agent shells run the CLIs' `.ts` under Bun.
   - Main and preload stay esbuild bundles (decided while building it, instead of Node module hooks). Electron's entry (`electron/start.mjs`) rebuilds them before main loads when a stat fingerprint of their sources changed, which takes about 0.2 s. A launch with nothing changed only pays the check. Reasons:
     - Main is about 13 MB of code that loads in one compile-cached file. Loading thousands of modules through a transform hook would slow every launch.
     - Main edits restart Electron anyway.
     - The preload is sandboxed, so it has to be a single CommonJS file.
   - Vite and electron-builder leave the product path. Both remain only for the release packaging build until the native launchers replace it (step 6), and step 7 deletes them.
3. **App repo on Artifacts.**
   - Publish the app subtree to an upstream repo, without binaries, which stay as launcher-managed assets on R2.
   - The backend forks it for each user and issues scoped tokens.
   - The local clone pushes self-mod commits to the user's fork.
4. **Drafts, preview, apply and sync.** Git is the only bookkeeping: no file tracking, no auto-generated commit metadata, no dev server. A skill teaches the agent the flow; the app adds only the buttons and a few git calls.
   - **Draft:** the agent makes a git worktree off the app checkout and edits, installs and typechecks there. The running app never sees a partial edit. When done, the agent commits the change as one normal commit on its draft branch, rebased onto the current `main`, so the draft is always a fast-forward of `main`.
   - **Preview:** a headless second window in the running app (hidden, `backgroundThrottling: false`; one extra renderer process, no second Electron or runtime; the agent screenshots it with `capturePage` and drives it over the DevTools protocol from main, and the user can ask to show it) on its own session partition, whose protocol handler serves the draft worktree instead of the checkout. It has its own browser storage and uses the user's real runtime and account, so the agent looks and navigates but doesn't take actions with side effects. Closed when the agent is done. Runtime changes are checked by typecheck and running the draft's code under Bun; main and preload changes by typecheck only.
   - **Apply is the user's click.** A finished draft shows an Update button. Clicking it fast-forwards `main` and swaps the change in by what the diff touched: renderer files hot-swap through the protocol handler (Fast Refresh, CSS swap, full reload as fallback); runtime files restart the runtime between turns; main or preload files relaunch Electron, which is cheap because the runtime is a sibling. Undo is the same button in reverse: a revert commit of the change, applied the same way.
   - **No automatic merging.** The app only fast-forwards. Whenever histories diverge (a draft whose base moved, another device's change, an upstream update), an agent merges in a draft and the result is offered through the same Update button.
   - **Sync:** applying pushes `main` to the user's Artifacts fork. Each device fetches the fork on launch and while idle; a fork ahead of local `main` shows the Update button ("changes from your other computer"), a diverged one goes to an agent. Pushes to the fork rebuild the user's browser renderer.
   - Renderer hot-swap and the module cache key by repo-relative path, so worktrees and checkouts share one content-addressed compile cache (this also gives step 6 a free rollback).
   - The renderer and runtime file watchers are removed; nothing applies until the user clicks Update.
5. **Updates through the same pipeline.**
   - An update is a draft that merges upstream; an agent resolves conflicts, the result is verified in the preview, and the user applies it with the same Update button.
   - Applied versions are signed with a key stored in the OS keychain, and unsigned trees are refused.
6. **Native launchers:** Swift/AppKit on macOS, C++/Win32 on Windows, C/GTK on Linux. Each one:
   - installs and updates the runtimes (Bun, git, Electron) and the source;
   - sets up the app's identity (on macOS: `Stella.app`, an ad-hoc signature and `disclaim-spawn`);
   - starts the runtime and the app, health-checks them, and detects crashes;
   - rolls back to the last known-good version and shows a recovery screen;
   - replaces the electron-builder installers.
7. **Delete:**
   - plugin apps (`apps-sdk`, `create-stella-app`, the workspace-app plugin loader);
   - the Vite production path;
   - the electron-builder packaging;
   - v1's hold-back machinery, which never gets carried over.

**v1 bugs fixed by construction:**
- control endpoints require authentication;
- held changes can't leak, because nothing is held;
- rollback returns to the last known-good version instead of `reset --hard`;
- self-mod identity comes from the local ledger, not commit trailers;
- only trusted packages may run install scripts.

## Order

1. Cloudflare 1 and 2.
2. v3 steps 1 and 2.
3. Cloudflare 3 and 4.
4. v3 steps 3 and 4.
5. Then the two tracks alternate. v3's per-user Artifacts fork works with the current JWT, so it doesn't wait for Cloudflare 10.

## New Cloudflare products (checked 2026-10-01)

- **Basin (generally available).** Adopted for cross-owner analytics and admin.
- **Artifacts (open beta).** Adopted for v3 source distribution and per-user forks. It is not used for the shared live world, because the binding can't write and repos are capped at 1 GB. Pricing is $0.15 per 1,000 operations and $0.50/GB-month, with billing starting 2026-10-14.
- **KV Instant (private beta).** Use it later for the gateway config snapshot.
- **K2 and ML-KEM/ML-DSA.** Not needed.

## Status

- [x] Cloudflare 1: owner platform (`96cb929cd`)
- [x] Cloudflare 2: turn-plane index (`e889cd1f4`, `391866409`, `368904096`). Deployed to dev and pushed with the origin merge (`44f112db0`). Verified live on a Pro test account: cloud chat reply, Fork to a new chat, and Rewind (`POST /api/rpc/conversations.rewind 200` in the worker tail).
- [x] v3 1: runtime as the app's sibling (`235d2301a`). Verified live: the runtime survived a SIGKILL of Electron during an agent turn, the relaunched app reattached 47 ms after connecting and showed the finished reply, and a runtime code change restarted the runtime with the app respawning it.
- [x] v3 2: run from source (`410d4bf9a` renderer, `0aa6e7f63` main, preload and runtime). Verified live:
  - The app launched with the renderer at `stella-app://desktop` and the runtime as `bun run packages/runtime/worker/entry.ts`.
  - With `dist-electron/runtime` deleted, agents ran `stella-x-api --help` and `stella-media --help` from their TypeScript sources and replied with the right first lines.
  - A runtime source edit restarted the runtime within 1 s, and the app reconnected.
  - A `main.ts` edit was live on the next launch (rebuilt in 199 ms). A launch with nothing changed skipped the build.

- [x] Cloudflare 3: billing and gateway control (`bcd0c106a`). Deployed to dev and pushed.
  - Verified live on a Pro test account:
    - The Billing screen read the owner object's ledger: Pro, live prices, credit options.
    - A chat turn minted its session capability through BillingControl (`/v1/capabilities/session` 200), and its usage settled into the ledger (`applyGatewayUsage`): $0.0011.
    - A second turn's charge reached analytics under the owner's pseudonym (`ingestForOwner` ok).
    - A self-signed credit-purchase webhook added $5 credit. A bad signature got 400, and a replay was deduped.
    - The ledger reported pro / paying / unlimited to Convex's `owner_billing_plans`.
    - A dictation prepare and settle through the bridge charged $0.005 once, across two settles.
    - The plan-gated model catalog resolved access through the bridge.
  - Verified on an anonymous account: chat minted through Convex's abuse admission and replied.
  - Not yet done:
    - (Done 2026-10-01) Dev uses the live Stripe account (no users). Live webhook `we_1ULz5EGxJob0lqtdxqfXfKaw` points at the dev worker with the 11 billing events, and its secret is dev's `STRIPE_WEBHOOK_SECRET`. A resent live `invoice.payment_succeeded` was delivered with 200.
    - The website needs `NEXT_PUBLIC_STELLA_BACKEND_URL`.
    - Production cloud-builder needs the same billing secrets before its next deploy.
- [x] Cloudflare 4: devices (`347318dbd`). Deployed to dev and pushed.
  - The owner object holds desktops, pairings, connect intents, the phone bridge and its sessions, push tokens and tunnels. The snapshot overlays devices and pairings from there. Phones and the desktop bridge use `/api/mobile/*` on cloud-builder; account deletion calls `/internal/devices/close`.
  - Verified live on dev:
    - Every route: register, identity, pairing, bridge status, connect request, session and consume, push, tunnel token, revoke. Bad proofs and replayed codes were refused.
    - A real tunnel was created with a proxied CNAME, and account close deleted both.
    - In the running app (Pro test account), the desktop registered and showed online with ready slots. "Stella on your phone" minted a live code with a QR. A phone redeemed it, and the dialog updated live to "1 phone paired".
    - The bridge then started, provisioned its tunnel through cloud-builder, registered, and served 200 through `t-….stellatunnel.com`. Removing the phone stopped cloudflared.
  - Left in Convex: the `cloud_dispatches` projection, which purge and the account-link migration still read. It goes with phase 5.
- [x] v3 3: app repo on Artifacts (`3fd2ca214`). Deployed to dev and pushed.
  - **Namespaces:** `stella-app-dev`, `stella-app-acceptance` and `stella-app-prod`.
  - **Publishing:** `bun run app-source:publish -- --namespace <ns>` publishes the repo minus the server, mobile app and tooling, about 80 MB. `bun.lock` is regenerated so a frozen install of the remaining workspaces passes. Each publish is one commit on upstream `main` with a `Stella-Source:` trailer, and an unchanged tree is a no-op.
  - **Forks:** `appSource.access` forks upstream on first use, as `u-<hash of owner>` (about 7–10 s), and returns 1 h tokens: write for the fork, read for upstream. The fork's 24 h creation token is revoked.
  - Verified live:
    - The fork cloned and matched upstream, with no server code.
    - A self-mod commit pushed to the fork, and `ls-remote` showed it.
    - The upstream read token got a 403 on push.
    - A second account got its own fork and a 403 on the first account's fork.
  - The client side (clone, push, merge upstream) lands with step 4, its first user.
- [~] v3 4: drafts, preview, apply and sync. Merged and pushed: `d5769ec8e`, `b55781194` (renderer HMR, path-independent cache, watchers removed, `requestRuntimeRestart`), `736b2d7bf` (harness main eval), `d41b11a20` (drafts, Update/Undo UI, preview tabs, fork sync, modify-stella skill).
  - Verified live: a component edit applied hot with composer state kept, a new Tailwind class applied hot, a runtime path returned "none", `main.tsx` reloaded, and `requestRuntimeRestart` replaced the runtime process.
  - Left: live check of the agent draft → preview → Update/Undo flow; two fork clones (republish upstream first); browser renderer rebuild on fork push.
- [~] Side task, Recall → code access to history (`e183d8cd7`, `da8fc08c8`): the Recall tool was deleted. The cloud orchestrator has `history.sql`/`history.read` in code, deployed to dev with prompts published. Open: signed-in desktop history lives in the cloud journal, not the local `entry` table, so the desktop needs the same `history` API via `POST /conversations/:id/history/query`. Design is in `handoff/README.md`.
