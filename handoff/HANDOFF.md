# Handoff: Stella v3 + all-Cloudflare backend

Written 2026-10-01 (lives in `handoff/` at the repo root) so a fresh agent on another machine can continue the
program without the earlier conversation. Read this file, then
[`stella-v3-and-cloudflare-plan.md`](stella-v3-and-cloudflare-plan.md) (the
full plan; its canonical copy lives in the author's `~/Documents`, so update
both copies when it changes), then the repo `CLAUDE.md`.

## The program

Two tracks:

- **Cloudflare:** move the whole backend to Cloudflare and delete Convex.
- **v3:** the app modifies itself from source, behind native launchers.

The Rust runtime port is paused, so ignore it.

Agreed order:

1. Cloudflare phases 1–2: **done**.
2. v3 steps 1–2: **done**.
3. Cloudflare phase 3: **done**. Phase 4 (devices) is **in progress**, about 40% (details below).
4. v3 steps 3–4.
5. After that the tracks alternate: Cloudflare phases 5–10 and v3 steps 5–7.

Decisions made in this stretch:

- Billing data lives in each owner's Durable Object (the `OwnerGate` SQLite), not in a shared database.
- Global data goes in D1. Hyperdrive with PlanetScale is the fallback only if D1 falls short.

## How the user wants you to work

These are standing directives. Follow them without re-asking.

- **Decide; don't ask.** Make the calls yourself. Don't present decision menus or "blockers for you"; work around environment blockers. The exception is outward-facing actions with real-world effect, such as registering a Stripe webhook or touching production.
- **Keep going until done.** Run the program continuously, without stopping between steps to report.
- **Evidence, not tests.** Don't write new tests. Prove changes live in the real product with evidence: worker tail lines, HTTP statuses, ledger rows, app screenshots. Delete tests that encode behaviour you removed. Existing suites must stay green.
- **No users exist.** Nothing needs compatibility code or migrations; replaced code is deleted.
- **Don't invent Durable Object migrations.** If wrangler complains about a DO migration, pull origin; another session probably added one.
- **Fetch origin first.** Fetch before starting work and before every deploy, rebase or merge, then push afterwards. Other sessions push master and deploy dev.
- **Keep plans minimal.** Do the smallest thing first, with no scaffolding.
- **Design docs go in `~/Documents`**, not the repo; this handoff is the exception. Commit messages:
  - end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - contain no model identifiers;
  - never include secrets.
- **Never touch production.** Deploy dev only.
- **Never create per-user Durable Objects from server-originated requests** (Convex pushes, crons). A DO is placed near its first caller, so the user's own request must create it. Convex may only call objects that already exist, such as active billing owners.
- **Test accounts** use emails ending in `@test.stella.local`.
- **Keep heavy work off the Electron renderer** (60fps bar).

## Done so far (all on `master`, pushed)

| Step | Commits |
|---|---|
| CF 1 owner platform (`/api/rpc/<fn>`, `/owners/me/live`, `owner_jobs`) | `96cb929cd` |
| CF 2 turn-plane index in the owner object | `e889cd1f4`, `391866409`, `368904096` |
| v3 1 runtime as the app's sibling process | `235d2301a` |
| v3 2 run from source (renderer via `stella-app://desktop`; runtime + CLIs as Bun-on-TS; main/preload esbuild-rebuilt by `packages/desktop/electron/start.mjs` on fingerprint change) | `410d4bf9a`, `0aa6e7f63` |
| sandbox-container uses Workers timers | `fd8ff9d72` |
| CF 3 billing in each owner's object | `bcd0c106a` |

The plan doc's Status section has the live evidence for each step.

### How phase 3 works

- **Owner object domain.** `workers/cloud-builder/src/owner-store/domains/billing.ts` holds the plan, Stripe ids, usage windows, credits, session grants and receipts.
- **Contracts.** They live in `packages/contracts/backend/billing.ts`, and `api.ts` merges every domain's calls and views.
- **Worker routes.** `workers/cloud-builder/src/billing/`:
  - `routes.ts`:
    - `POST /api/stripe/webhook`. The owner is found from `metadata.ownerId`, event ids are deduped, and subscription events are refetched.
    - `POST /internal/billing/{access,usage,plan,close}`, which uses the builder service secret.
  - `stripe.ts`: plain fetch, API version `2026-05-27.dahlia`.
  - `plans.ts`: plan limits from env, using the old Convex variable names.
  - `control.ts`: the `BillingControl` WorkerEntrypoint.
- **Gateway.**
  - The model gateway binds `BillingControl` as `BILLING` (`workers/model-gateway/src/billing-control.ts`).
  - Session capability mint:
    1. Convex `/api/gateway/session-admission` handles abuse only.
    2. The owner object reserves a grant.
    3. cloud-builder signs the capability (iss `stella-cloud-builder`).
  - The gateway's usage queue settles into cloud-builder first, then posts an abuse-only copy to Convex `/api/gateway/usage`.
- **Snapshot.** `OwnerGate.snapshot()` = the Convex control snapshot plus the plan and allowance from the local ledger (`withBilling`). If billing config is missing (`BillingConfigError`), it serves the control snapshot unchanged.
- **Convex's remaining spenders** go through `packages/backend/convex/billing_bridge.ts` and `lib/managed_billing.ts`. These are media, music, voice, dictation, search and emoji packs.
- **Plan mirror.** The ledger pushes `{plan, paying, unlimited}` to Convex `/api/billing/owner-plan` (table `owner_billing_plans`). The "paying" identity rung needs it until phase 10.
- **Telemetry.** `inference.completed` events go through `TelemetryService.ingestForOwner`. `agentType` must match SAFE_LABEL, so it can't contain `:`.

### Phase 3 loose ends (not blocking)

- **Stripe webhook endpoint.** One must be registered for `https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev/api/stripe/webhook`, with its signing secret set as cloud-builder `STRIPE_WEBHOOK_SECRET`. Dev currently holds a generated secret that is only good for self-signed checks. Registering is outward-facing, so get the user's OK.
- **Dev's `STRIPE_SECRET_KEY` is NOT a test-mode key.** Never create Checkout sessions, customers or charges to "verify".
- **Website.** It needs `NEXT_PUBLIC_STELLA_BACKEND_URL`.
- **Production.** Production cloud-builder needs the billing secrets before its next deploy. Don't do this without being asked.

## Phase 4 (devices): where it stands

Goal: the owner's devices move into the owner object, and the Convex modules for them are deleted. That covers:

- desktops that can run work (signing keys, capabilities, id succession);
- phone pairing;
- the desktop's phone bridge and bridge sessions;
- push tokens and activity notifications;
- Cloudflare tunnels for the bridge.

### Written but not wired (committed, inert)

- **`packages/contracts/backend/devices.ts`**, merged into `api.ts`.
  - `DeviceCalls`: `devices.identity`, `devices.register`, `devices.adoptSuccession`, `phone.createPairing`, `phone.revoke`, `phone.acknowledgeIntent`, `phone.notifyActivity`.
  - `DeviceViews`: `phone.access` and `phone.connectIntent`.
- **`workers/cloud-builder/src/devices/cloudflare-tunnels.ts`**: the Cloudflare tunnel and DNS API.
  - `tunnelCredentials(env)` reads `CLOUDFLARE_API_TOKEN`, `CF_ACCOUNT_ID` and `CF_ZONE_ID`.
  - Names are `t-<20 hex of sha256(owner\0device)>.stellatunnel.com`.
  - It also has create, DNS write and repair, existence checks, and delete-by-id-and-name.
- **`workers/cloud-builder/src/owner-store/domains/devices.ts`**: the domain.
  - Migration `devices.1-registry` creates the tables `devices`, `device_successors`, `paired_phones`, `pairing_codes`, `connect_intents`, `bridge_registrations`, `bridge_sessions`, `push_tokens` and `tunnels`.
  - Calls and views are listed under the contracts above.
  - `snapshotDevices(db)` gives the devices and pairedDevices for the snapshot overlay.
  - Pair proof: an HMAC keyed by the pair-secret hash over `stella-mobile-bridge-pair-proof-v1`.
  - Tunnel provisioning requires identity level ≥ 2. Phones are notified through Expo push.
  - The sweep job is `devices.sweep`.
  - `handleMobileRoute(ctx, {route, caller, query, body, headers})` serves:
    - `GET desktop-bridge`
    - `POST push-token`, `push-token/unregister`, `pairing/complete`
    - `POST desktop-bridge/{register,clear,request,session,session/consume,tunnel-token}`
  - Export: `devicesDomain`.

The cloud-builder typecheck passes with these files unregistered.

### Remaining checklist

1. **Register the domain.** Add `devicesDomain` at the end of `ownerDomains` in `workers/cloud-builder/src/owner-store/domains.ts`; order matters, so append. Then typecheck and run `bun run test:unit` in `workers/cloud-builder`.
2. **Overlay devices on the snapshot.** In `OwnerGate.withBilling` (`workers/cloud-builder/src/owner-gate.ts`), overlay `snapshotDevices(db)`, so the snapshot's devices come from the owner object and not Convex.
3. **Add routes.**
   - An `OwnerGate` method `mobileRoute(input)` that calls `handleMobileRoute`.
   - Worker routes `/api/mobile/*` with user-JWT auth, using the same verification the RPC routes use. The caller is the device or phone identity from headers or body, as in Convex `http_routes/mobile.ts`.
   - `/internal/devices/close`, using the service secret, for account deletion; it calls `deleteTunnels`.
4. **Copy secrets.** Copy `CF_ACCOUNT_ID`, `CF_ZONE_ID` and `CLOUDFLARE_API_TOKEN` from Convex env to cloud-builder dev secrets, piping the values without printing them:

   ```bash
   cd packages/backend && bunx convex env get CF_ZONE_ID | (cd ../../workers/cloud-builder && bunx wrangler secret put CF_ZONE_ID --env "")
   ```
5. **Switch the clients.**
   - desktop-ui: `use-phone-access-controller`, `PhoneAccessBridge` and `MobileActivityNotificationsBridge` move to the backend client (`@stella/contracts/backend` RPC and live views).
   - electron: `mobile-bridge/service.js` and `tunnel-service.ts` call cloud-builder `/api/mobile/*`.
   - runtime: in `execution-placement-bridge.ts`, `readIdentity` and `registerDevice` go through the backendUrl RPC (`devices.identity` / `devices.register`). The device-id succession at `packages/desktop/.../host/index.js` (~line 718) calls `devices.adoptSuccession`.
   - mobile: the base URL for `/api/mobile/*` becomes `backendUrl` (the cloud-builder origin).
6. **Delete Convex.** Remove:
   - the modules `device_identity.ts`, `execution_placement.ts`, `mobile_access.ts`, `mobile_auth.ts`, `mobile_bridge.ts`, `mobile_push.ts` and `cloudflare_tunnels.ts`, and their `*.convex.test.ts`;
   - `http_routes/mobile.ts`;
   - `schema/devices.ts`;
   - the "purge idle cloudflare tunnels" cron in `crons.ts`;
   - the `cloud_dispatches` outbox projection, once nothing reads it.

   Then regenerate `convex-api.ts` with the generator; don't hand-edit it, because its check needs the generator's exact output. Fix the fallout and keep the Convex tests green.
7. **Deploy and verify.**
   - Fetch origin and deploy dev, both workers and Convex.
   - Live-verify on a Pro test account:
     - desktop registration and identity;
     - create a pairing code; complete pairing from Android, which is the only mobile platform verifiable locally (no iOS);
     - get a tunnel token, open a bridge session and consume it;
     - register a push token and send an activity notification;
     - revoke the phone.
   - Commit, push, and update the plan doc's Status in both copies.

Then do v3 steps 3–4 (Artifacts app repo; drafts, preview, apply and ledger). The plan doc has their shape.

## Ops cheat sheet

- **Dev Convex.** Write `packages/backend/.env.local` if it's missing:
  ```
  CONVEX_DEPLOYMENT=dev:outgoing-bulldog-865
  CONVEX_URL=https://outgoing-bulldog-865.convex.cloud
  CONVEX_SITE_URL=https://outgoing-bulldog-865.convex.site
  ```
  Deploy with `cd packages/backend && bunx convex dev --once --typecheck disable`.
- **Workers.** Deploy cloud-builder with `cd workers/cloud-builder && bun run deploy:dev`, and model-gateway the same way from its own folder. The dev URL is `https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev`.
- **Checks.**
  - Typecheck: `bun run typecheck` in each worker.
  - Unit tests: `bun run test:unit`.
  - Ratchet: `bun run check:ratchet` from the repo root.
  - Promise lint: `bun run cloud-builder:lint:promises`.
- **Secrets.** `CLOUD_BUILDER_URL`, `BUILDER_SERVICE_SECRET` and `STELLA_ADMIN_API_SECRET` come from `bunx convex env get <NAME>` in `packages/backend`. Never print or commit them.
- **Desktop app.** Drive the real app with `.agents/skills/verify-stella/SKILL.md`, e.g. `node .agents/skills/verify-stella/control-stella.mjs session launch --account pro`. `TESTING.md` has the rest.
- **Live evidence.** `bunx wrangler tail` drops many long-DO logs; prefer the HTTP statuses and responses, ledger rows read back through RPC, and app screenshots.
- **Container rollouts.** An image-changing deploy rolls containers. For about 10 minutes, "Maximum number of running container instances exceeded" is rollout lag, not a leak.
- **Bun tests.** `mock.module` is process-global and leaks across test files. Gate mocks with a flag and captured real exports.
