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
| Website + web chat | Vercel preview | Vercel production (`stella.sh`) |
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

## Website and web chat

Vercel builds `packages/website` on every push to `master`; nothing to run.
Env lives in Vercel (`vercel env ls`); prod uses
`NEXT_PUBLIC_STELLA_BACKEND_URL` = the prod backend.

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

**App Store / Play release: only when explicitly asked.** `eas build --profile
production` then `eas submit`, per platform.

## Smoke check after a prod deploy

- `curl -s https://auth.stella.sh/api/auth/jwks` → 200.
- Anonymous sign-in, then one chat turn: `POST /api/auth/sign-in/anonymous`,
  `GET /api/auth/token`, `POST /conversations/<uuid>/turns`
  `{"protocol":1,"clientMsgId":"<uuid>","prompt":"Reply with exactly: ok","lane":"chat"}`,
  then poll `GET /conversations/<uuid>/history` for the assistant reply.
- Desktop against a given backend: `STELLA_BACKEND_URL=<backend> TMPDIR=/tmp node .agents/skills/verify-stella/control-stella.mjs session launch`.
