# Agent notes for stella-v2

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

Non-secret dev deployment values (public service locations, same tier as the
tracked `VITE_CONVEX_URL`). Write them to `packages/backend/.env.local` if it
is absent:

```
CONVEX_DEPLOYMENT=dev:outgoing-bulldog-865
CONVEX_URL=https://outgoing-bulldog-865.convex.cloud
CONVEX_SITE_URL=https://outgoing-bulldog-865.convex.site
```

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
- Chat working indicator is orchestrator-only: hold a status ~2s then skip to the latest; hide when assistant text starts; after a tool, if still busy with no text, return to thinking. Thinking phrases should be random, not turn-based. Status copy should be short everyday phrases (one or two words), not developer jargon, tool names, or long "on your computer" phrasing.

## Learned Workspace Facts
- Stella (this repo: stella-v2) is the user's Electron desktop product; it also has a mobile package.
- Linux development and packaging target Omarchy (Arch + Hyprland). Ship Arch `.pkg.tar.xz` via pacman and AppImage, not `.deb`.
- Windows already uses electron-builder NSIS with `oneClick`; the Arch package is an fpm/pacman archive with a desktop entry and is treated as a tarball on double-click.
- Electron main vs renderer is not strictly bounded; heavy work pulled into the renderer is a known jank source.
- File previews (including CSV from `display:readFile`) must be capped or parsed off the UI thread; unbounded parse on the renderer is a known jank source.
