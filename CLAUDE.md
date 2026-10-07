# Agent notes for stella-v2

## Product overview

Stella is an AI personal assistant available on desktop, in the browser, and on
mobile platforms. Unlike chatbots organized around many chats or threads,
Stella is primarily one long-running chat experience, with the occasional
option to create a new or separate chat. Stella acts as an orchestrator and
does not perform work directly. It spawns agents to perform work either locally
on the user's computer or in the cloud. All agents run in the background, so
Stella is always able to respond without being blocked.

### Stella modifies itself

The differentiator: users change Stella itself by asking Stella. The desktop
app runs from its own source (a git checkout in the app dir, renderer served
from source, runtime on Bun, no packaging), started by the native launchers in
`launcher/`. The source lives on Cloudflare Artifacts: one `upstream` repo
that we publish, plus a private fork per user.

- A change the user asks for is made by an agent in a draft (a git worktree
  under the drafts dir), checked in a preview window inside the running app,
  and applied only when the user clicks Update. Applying fast-forwards the
  checkout and pushes it to the user's fork; Undo reverts. The agent workflow
  is the seeded skill `packages/home-seed/skills/modify-stella/SKILL.md`.
- The user's other computers fetch the fork and offer what it would actually
  change there; a fork whose files this computer already has (duplicate merge
  history) is joined silently and never offered. Nothing is applied on a
  device without a click there.
- Our official updates are merges from `upstream`. Everything that can be
  added shows as an "N updates" pill above the composer, which opens the
  Updates section of the right sidebar (Add / Skip, then history with Undo).
  When an update conflicts with the user's own changes, an agent merges in the
  background.
- The app only ever fast-forwards; any divergence is merged by an agent, never
  by git's automatic three-way merge.
- Code lives in `packages/desktop/electron/services/app-source/` and
  `packages/desktop-ui/src/features/app-source/`; publishing upstream is
  `bun run app-source:publish -- --namespace <ns>`. Fetch from Artifacts over
  git protocol v2 (its v1 fetch is broken); push over v1.

## Deploying

The dev and prod release flow (Cloudflare workers, app source, launchers,
website, mobile OTA) is in `DEPLOY.md`. Follow it as written.
Running Stella on another Cloudflare account is `SELF_HOSTING.md`.

## Cloud agents: required environment

The clone plus `bun install --frozen-lockfile` is enough to typecheck and run
every test suite (see `.github/workflows/ci.yml`). Anything that talks to a
live deployment needs these variables in the agent's environment. If a
`wrangler` command fails on auth, a missing one of these is the blocker;
report it rather than working around it.

Secrets (set in the agent platform's secret store, never committed):

- `CLOUDFLARE_API_TOKEN`: token with Workers Scripts and Durable Objects edit.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account that owns the workers.
- `STELLA_ADMIN_API_SECRET`: the dev backend's admin bearer (test accounts).
  Export it, or put `STELLA_ADMIN_API_SECRET=...` in the gitignored
  `workers/cloud-builder/.dev.vars`, which the verify-stella scripts read.

The backend is the cloud-builder worker. Its dev URL is a public service
location, the same one source builds use for `VITE_STELLA_BACKEND_URL`:

```
STELLA_BACKEND_URL=https://stella-v2-cloud-builder-dev.fromyou.workers.dev
```

### Test accounts

Launch Electron with a signed-in Pro test account:
`node .agents/skills/verify-stella/control-stella.mjs session launch --account pro`.
For other clients, use
`curl -sS -X POST -H "Authorization: Bearer $STELLA_ADMIN_API_SECRET" -H "Content-Type: application/json" -d '{"email":"agent-manual@test.stella.local","plan":"pro","usageMode":"unlimited"}' "$STELLA_BACKEND_URL/api/admin/test-accounts/session"`.
The dev backend has `STELLA_TEST_ACCOUNTS=1`; production never does. Test
emails must end in `@test.stella.local`.

Build and setup steps are not scripted beyond CI; do them as needed. Desktop
verification is documented in `TESTING.md` and driven through
`.agents/skills/verify-stella/SKILL.md` (Electron needs an X display; use
Xvfb on a headless host). iOS verification runs on the Mac: an agent elsewhere
moves itself to the Mac for iOS work. It is unavailable from cloud
environments; treat that as a valid blocker. The iOS dev
build signs into a test account with `control-stella-ios.sh sign-in`.

## Learned User Preferences
- Keep heavy I/O and compute off the Electron renderer; 60fps / ~16ms per frame is the product bar for a smooth UI.
- When given another product's process as an example, apply the intent (for example renderer/main isolation), not that product's CI or import-graph scaffolding, unless asked.
- Uses `/poteto-mode` (pstack) for architecture and quality work.
- Wants a one-click Linux/Omarchy install path comparable to Windows, not a terminal-only flow.

## Learned Workspace Facts
- Stella (this repo: stella-v2) is the user's Electron desktop product; it also has a mobile package.
- Linux development targets Omarchy (Arch + Hyprland).
- Desktop ships only through the native launchers (`launcher/{macos,windows,linux}`), which run the app from source; there is no electron-builder packaging or electron-updater.
- Electron main vs renderer is not strictly bounded; heavy work pulled into the renderer is a known jank source.
- File previews (including CSV from `display:readFile`) must be capped or parsed off the UI thread; unbounded parse on the renderer is a known jank source.
