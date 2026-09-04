# Agent notes for stella-v2

## Product overview

Stella is an AI personal assistant available on desktop, in the browser, and on
mobile platforms. Unlike chatbots organized around many chats or threads,
Stella is primarily one long-running chat experience, with the occasional
option to create a new or separate chat. Stella acts as an orchestrator and
does not perform work directly. It spawns agents to perform work either locally
on the user's computer or in the cloud. All agents run in the background, so
Stella is always able to respond without being blocked.

## Cloud agents: required environment

The clone plus `bun install --frozen-lockfile` is enough to typecheck and run
every test suite (see `.github/workflows/ci.yml`). Anything that talks to a
live deployment needs these variables in the agent's environment. If a
`convex` or `wrangler` command fails on auth, a missing one of these is the
blocker; report it rather than working around it.

Secrets (set in the agent platform's secret store, never committed):

- `CONVEX_DEPLOY_KEY`: deploy key for the dev deployment below.
- `CLOUDFLARE_API_TOKEN`: token with Workers Scripts and Durable Objects edit.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account that owns the workers.

The non-secret dev deployment values (public service locations, same tier as
the tracked `VITE_CONVEX_URL`) are committed in `packages/backend/.env`, so no
setup step is needed. The Convex CLI still owns `packages/backend/.env.local`
and writes deploy state there; that file stays gitignored and overrides `.env`
when present.

Use `bunx convex env get <NAME>` to read a single deployment variable. Avoid
`convex env list` in an agent session: it prints every deployment secret in
cleartext into the transcript.

### Test accounts

Launch Electron with a signed-in Pro test account:
`node .agents/skills/verify-stella/control-stella.mjs session launch --account pro`.
For other clients, use
`curl -sS -X POST -H "Authorization: Bearer $STELLA_ADMIN_API_SECRET" -H "Content-Type: application/json" -d '{"email":"agent-manual@test.stella.local","plan":"pro","usageMode":"unlimited"}' "$CONVEX_SITE_URL/api/admin/test-accounts/session"`.
Supply `STELLA_ADMIN_API_SECRET` through the agent secret store or read it from
`packages/backend` with `bunx convex env get STELLA_ADMIN_API_SECRET`. The dev
deployment has `STELLA_TEST_ACCOUNTS=1`; production never does. Test emails
must end in `@test.stella.local`.

Build and setup steps are not scripted beyond CI; do them as needed. Desktop
verification is documented in `TESTING.md` and driven through
`.agents/skills/verify-stella/SKILL.md` (Electron needs an X display; use
Xvfb on a headless host). iOS verification requires the `stella-mac` SSH
host and is unavailable from cloud environments; treat it as a valid blocker.

## Learned User Preferences
- Keep heavy I/O and compute off the Electron renderer; 60fps / ~16ms per frame is the product bar for a smooth UI.
- When given another product's process as an example, apply the intent (for example renderer/main isolation), not that product's CI or import-graph scaffolding, unless asked.
- Uses `/poteto-mode` (pstack) for architecture and quality work.
- Wants a one-click Linux/Omarchy install path comparable to the Windows NSIS installer, not a terminal-only `pacman -U` flow.

## Learned Workspace Facts
- Stella (this repo: stella-v2) is the user's Electron desktop product; it also has a mobile package.
- Linux development and packaging target Omarchy (Arch + Hyprland). Ship Arch `.pkg.tar.xz` via pacman and AppImage, not `.deb`.
- Windows already uses electron-builder NSIS with `oneClick`; the Arch package is an fpm/pacman archive with a desktop entry and is treated as a tarball on double-click.
- Electron main vs renderer is not strictly bounded; heavy work pulled into the renderer is a known jank source.
- File previews (including CSV from `display:readFile`) must be capped or parsed off the UI thread; unbounded parse on the renderer is a known jank source.
