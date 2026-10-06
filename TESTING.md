# Stella v2 local testing

This repository is a local v2 test surface. It intentionally shares the
production `com.stella.app` bundle ID with Stella v1, so keep the two apps
separate and **never replace `/Applications/Stella.app`**.

## Development mode

The real Electron development command is `bun run electron:dev`. A normal
launch uses the same `~/.stella` home, conversation database, configuration,
credentials, and `electron-user-data` as Stella v1 and the installed v2 app:

```sh
bun run electron:dev
```

Stella runs from source. Electron serves the renderer from `packages/desktop-ui`
itself (transformed on request and cached), main and preload are rebuilt at
launch only when their sources changed, and the runtime is Bun running
`packages/runtime` TypeScript. There is no dev server or build step: renderer
edits reload the window, runtime edits restart the runtime when it is idle, and
main or preload edits apply on the next launch. Fully quit v1 first: both apps
use the same Electron process-singleton path, so the second launch exits instead
of opening the shared database concurrently. Quit the terminal process with
`Ctrl-C` when finished.

Tests and harnesses that need isolation must opt in explicitly:

```sh
isolated_root=$(mktemp -d "${TMPDIR:-/tmp}/stella-v2-test.XXXXXX")
STELLA_V2_DEV_DATA_DIR="$isolated_root" bun run electron:dev
```

`STELLA_V2_DEV_DATA_DIR` is the only development data-root override. Generic
`STELLA_DATA_DIR` is ignored, and destructive reset commands require the
explicit isolated override.

## Test accounts

Launch the isolated Electron verifier with a signed-in paid account:

```sh
node .agents/skills/verify-stella/control-stella.mjs session launch --account pro
```

The harness targets `STELLA_BACKEND_URL` (default: the dev cloud-builder
worker, `https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev`). It reads
`STELLA_ADMIN_API_SECRET` from the environment or the gitignored
`workers/cloud-builder/.dev.vars`. For a non-Electron client, mint a session
directly:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $STELLA_ADMIN_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"agent-manual@test.stella.local","plan":"pro","usageMode":"unlimited"}' \
  "$STELLA_BACKEND_URL/api/admin/test-accounts/session"
```

The dev deployment has `STELLA_TEST_ACCOUNTS=1`; production never does. The
route accepts only addresses ending in `@test.stella.local`.

The iOS dev build signs into a test account through the same route:

```sh
.agents/skills/verify-stella/scripts/control-stella-ios.sh sign-in --plan pro
```

The response also carries a three-minute, single-use `oneTimeToken`. The helper
opens `stella-mobile://dev-test-session?ott=…` in the booted Simulator, and the
app exchanges it through Better Auth's one-time-token verify, the same exchange
its OAuth callbacks use. The app refuses the link outside a development build
(`__DEV__`), against any backend other than dev, and for any account outside
`@test.stella.local` (it signs that session straight back out). Production
never mints the token because it has no test-accounts route.

## Installed builds

Desktop ships only through the native launchers in `launcher/macos`,
`launcher/windows`, and `launcher/linux`. A launcher installs its managed
runtimes and a checkout of this source tree, then runs it exactly as
`electron:dev` does (renderer from source, main and preload rebuilt when stale,
runtime under Bun) with `STELLA_LAUNCHER=1`, which gives the run Stella's own
name, Electron user data, and `~/.stella` home. There is no packaged build or
electron-updater feed: updates arrive as app source changes and are applied
from the in-app Update card.

Because of that, `app.isPackaged` is false in the installed product as well as
in a checkout, and nothing may use it to ask "am I the shipped app". The one
answer lives in `packages/desktop/electron/app-identity.ts`
(`resolveAppInstall`, `isInstalledProduct`, `isDeveloperInstance`,
`isDevHarness`), derived from `STELLA_LAUNCHER=1` and `STELLA_DEV_HARNESS=1`.
Call it instead of adding a predicate. What it deliberately does not answer:
whether the app runs from source (always true), and the renderer's build mode
(`resolveRendererBuildMode`, overridable with `STELLA_RENDERER_MODE`, which is
what `import.meta.env.DEV` reflects).
