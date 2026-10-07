# Deploying Stella (dev and prod)

Commit to `master`, `git fetch` + rebase before deploying, push after. Other
sessions deploy dev too. Never print secrets: pipe them into `wrangler secret put`.

## What lives where

| Piece | Dev | Prod |
|---|---|---|
| Backend (cloud-builder) | `stella-v2-cloud-builder-dev.lolruuxi.workers.dev`, `auth-dev.stella.sh` | `stella-v2-cloud-builder-prod.lolruuxi.workers.dev`, `auth.stella.sh` |
| Model gateway | `stella-v2-model-gateway-dev` | `stella-v2-model-gateway` |
| D1 | `stella-v2-dev` | `stella-v2-prod` |
| App source (Artifacts) | `stella-app-dev` | `stella-app-prod` |
| Website + web chat | Worker `stella-website-dev` (`stella-website-dev.lolruuxi.workers.dev`) | Worker `stella-website-prod` on `stella.sh` (Vercel kept as fallback, see the cutover below) |
| Mobile OTA channel | `preview` | `production` |
| Desktop | source checkout / verify harness | native launchers from R2 `launcher/stable/` |

Other workers: `telemetry`, `browser-gateway`, `apps-host` (dev and prod envs),
`canvas-share` (one deployment, `stellashare.app`).

## Cloudflare workers

Run from each worker's directory. Use the Wrangler login, not the `.dev.vars`
token (it can't push containers): prefix with `env -u CLOUDFLARE_API_TOKEN`.
cloud-builder builds its container image, so Docker must respond (`docker info`;
if it hangs, force-quit and reopen Docker Desktop).

Order: **D1 migrations → cloud-builder → model-gateway → the rest.** The gateway
prices models from cloud-builder's catalog, so a new model must reach
cloud-builder first. A deploy kills in-flight resident cloud turns.

```bash
# dev
cd workers/cloud-builder && bunx wrangler d1 migrations apply stella-v2-dev --remote
env -u CLOUDFLARE_API_TOKEN bun run deploy:dev            # cloud-builder
cd ../model-gateway && env -u CLOUDFLARE_API_TOKEN bun run deploy:dev
# then telemetry, browser-gateway, apps-host: bun run deploy:dev

# prod
cd workers/cloud-builder && bunx wrangler d1 migrations apply stella-v2-prod --env production --remote
env -u CLOUDFLARE_API_TOKEN bun run deploy:production
cd ../model-gateway && env -u CLOUDFLARE_API_TOKEN bun run deploy:production
# then telemetry, browser-gateway, apps-host: bun run deploy:production
# canvas-share (only when it changed): bun run deploy
```

New bindings, vars or secrets: add them to the `env.production` block of the
worker's `wrangler.jsonc` too (bindings and vars don't inherit), regenerate
types (`node scripts/generate-worker-types.mjs` in cloud-builder), and set prod
secrets before the prod deploy: `... | bunx wrangler secret put NAME --env production`.

### Prompts

Edit `packages/runtime/extensions/stella-runtime/agent-metadata/*.md` or
`prompts/*.md`, run `bun run prompts:sync-defaults`, commit. Deploying
cloud-builder publishes them. Check: `curl -s <backend>/api/stella/prompts`
revision equals `bun run prompts:check-defaults`.

## Desktop

The desktop app runs from source published to Artifacts; launchers install and
update from it.

1. **App source** (any desktop/runtime change):
   `env -u CLOUDFLARE_API_TOKEN bun run app-source:publish -- --namespace stella-app-dev`
   (and `stella-app-prod` for prod). An unchanged tree publishes nothing.
2. **Launchers** (only when `launcher/` changed): `gh workflow run build-launchers.yml --ref master -f publish=true`.
   It signs and notarizes macOS (DMG + zip), signs `Stella.exe`, builds the Linux
   binaries, and uploads them with `VERSION` to `launcher/stable/`. Installed
   launchers update themselves from `VERSION`.
3. **Electron version bump**: the push of `package.json` runs
   `build-electron-identity.yml`, which publishes the Developer ID-signed
   `Stella.app` for that Electron version. Let it finish before users launch,
   or macOS launchers fall back to an ad-hoc copy and prompt for the Keychain.
4. **Native helpers** (only when `packages/native/` changed):
   `build-native-helpers.yml` publishes them and self-verifies by reading
   `current.json` back. What is live now:
   `curl -s https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/native-helpers/current.json`.

What users are actually on: each publish is one commit on that namespace's
`upstream` repo carrying a `Stella-Source: <monorepo sha>` trailer, so reading
that repo's head says which commit the channel serves — and therefore what a
publish will really ship. Check it before calling a publish "one fix": the
namespace can be many commits behind master.

## Website and web chat

`packages/website` runs on Cloudflare Workers through OpenNext. Nothing deploys
on push; run it from `packages/website` after rebasing. Put `/usr/bin` first on
`PATH` where `node` is an Electron shim, and keep the `VITE_*` and `NEXT_PUBLIC_*`
values out of the way: `scripts/deploy-stella.sh` pins every public value itself
(backend, site URL, Turnstile key; the Google Ads tag only in `production`). The
Maps browser key is the one value it takes from the environment.

```bash
cd packages/website
# dev → https://stella-website-dev.lolruuxi.workers.dev (dev backend, no Ads tag)
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY="$(cat <browser key file>)" env -u CLOUDFLARE_API_TOKEN bun run deploy:dev
# prod → stella-website-prod (prod backend, Ads tag on); refuses without the browser key
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY="$(cat <browser key file>)" env -u CLOUDFLARE_API_TOKEN bun run deploy:production
```

The only runtime secret is `GOOGLE_MAPS_SERVER_API_KEY` (the legacy
`POST /api/maps/resolve` for released desktops):
`env -u CLOUDFLARE_API_TOKEN bunx wrangler secret put GOOGLE_MAPS_SERVER_API_KEY --env="" < <server key file>`
(`--env production` for prod). The browser key is referrer-restricted to
`stella.sh` and `localhost:3000`, so maps on a workers.dev URL show
`RefererNotAllowedMapError`. The dev backend does not trust the workers.dev origin
either, so sign-in and `/chat` there fail CORS. Test those against the built
Worker locally on a trusted origin:
`env -u CLOUDFLARE_API_TOKEN bunx wrangler dev --port 57314 --env=""` (use
`--port 3000` for maps).

`wrangler.jsonc` holds both Workers. `worker.mjs` wraps the OpenNext worker so
responses match Vercel: prerendered HTML gets `public, max-age=0, must-revalidate`
instead of Next's raw `s-maxage`, and `/_next/image` is cached for a day.
`public/_headers` sets the static-asset headers (`/_next/static`, `/chat-app`,
logos, mock images) that `next.config.ts` headers cannot reach on Workers. Pages
are served from the build's static-assets cache, so there is no ISR: adding
`revalidate` or `unstable_cache` needs the R2 incremental cache.

### Cutover from Vercel (done 2026-10-07)

`stella.sh` is a Workers custom domain on `stella-website-prod` (`routes` in
`env.production`). Before the cutover it was a DNS-only `CNAME stella.sh →
dfd97f9c23152005.vercel-dns-016.com`. `www.stella.sh` is still the Vercel CNAME,
and Vercel redirects it to the apex. The Vercel project stays connected as the
fallback until the switch is confirmed.

- Rollback: remove the `stella.sh` custom domain from `stella-website-prod`
  (dashboard → Workers → Settings → Domains & Routes), recreate the DNS-only
  CNAME above, and comment `routes` again. Vercel still builds master, so it
  serves the same site.
- When confirmed: move `www.stella.sh` to a proxied `AAAA 100::` record with a
  Redirect Rule `www.stella.sh/*` → `https://stella.sh/${1}` (301, keep the
  query string), then in Vercel disconnect the Git integration, remove both
  domains and delete the project.

## Mobile

**OTA is the default.** Run per platform, from `packages/mobile`, with a clean tree:

```bash
STELLA_OTA_PIN_STORE_RUNTIME=1 scripts/publish-ota.sh production ios
STELLA_OTA_PIN_STORE_RUNTIME=1 scripts/publish-ota.sh production android
```

(`preview` instead of `production` for dev builds.) The script targets the build
the stores actually serve. `STELLA_OTA_PIN_STORE_RUNTIME=1` is needed because the
fingerprint drifts with bun's store paths; it refuses if any native package or
native input changed since the store build, and then only a store build can ship it.
The bundle's env comes from the EAS environment (`eas env:list --environment production`).

`--native-match`, which `STELLA_OTA_PIN_STORE_RUNTIME=1` runs, compares this tree's
native inputs against the *store build's commit*: `packages/mobile/app.json`,
`plugins`, `modules`, `widgets`, `targets`, `patches/`, plus native package versions
in `bun.lock`. **Deletions count exactly like additions** — the diff has no status
filter — so removing a native module trips it; patches of non-native packages are
ignored. When master has moved natively but its JS is what you want to ship, publish
from a release-only commit, never pushed to master, whose native inputs match the
target build exactly: revert the native-only patch, restore files the target still
has, and put `app.json` back to the target's version. Prove two things before
publishing — the exported bundle really carries the change, and an export differing
only by the restored files is byte-identical.

**Runtimes, not versions, decide who receives an update.** A binary asks for its
channel and its own fingerprint runtime, so every live build needs its own group. The
script pins to the build the stores serve, so once a newer build goes live the older
runtime can no longer be targeted through it: those stragglers keep the last group they
got and catch up when the store updates them. `STELLA_OTA_IOS_TESTFLIGHT_BUILD=<n>`
targets an iOS build that exists in App Store Connect but is not live yet, so a binary
in review already has its update waiting the moment it is approved.

**`eas.json` pins bun** (`"bun"` in each build profile). The fingerprint hashes bun's
store paths, so if the builders' bun differs from the one that resolved `bun.lock`,
every build dies in `CONFIGURE_EXPO_UPDATES` with a local-vs-EAS runtime mismatch. Keep
the pin equal to the bun that owns the lockfile.

`publish-ota.sh` invokes `bunx`, which Stella's bundled bun does not ship; put a shim
on `PATH` rather than editing the script.

**App Store / Play release: only when explicitly asked.** `eas build --profile
production` then `eas submit`, per platform. Apple rejects a submission that reuses
`expo.version`, so bump it in `app.json` first; build numbers come from EAS
(`appVersionSource: remote`). Confirm the Android submit prints
`Release track: production` — it falls back to internal when the profile says nothing.
ASC app id `6761148311`, Apple team `7UVYHQ763X`, Android package `com.fromyou.stella`.

Whether a submission happened is the **App Store version's** review state, not the
build's: a build row can read "Ready to Submit" in TestFlight while the version itself
is "Waiting for Review", and the public-build resolver only ever reports what is already
live. Read the version.

## Smoke check after a prod deploy

- `curl -s https://auth.stella.sh/api/auth/jwks` → 200.
- Anonymous sign-in, then one chat turn: `POST /api/auth/sign-in/anonymous`,
  `GET /api/auth/token`, `POST /conversations/<uuid>/turns`
  `{"protocol":1,"clientMsgId":"<uuid>","prompt":"Reply with exactly: ok","lane":"chat"}`,
  then poll `GET /conversations/<uuid>/history` for the assistant reply.
- Desktop against a given backend: `STELLA_BACKEND_URL=<backend> TMPDIR=/tmp node .agents/skills/verify-stella/control-stella.mjs session launch`.
