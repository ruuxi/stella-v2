# Desktop packaging (M2)

## Renderer

Production uses `BrowserWindow.loadFile()` and the Vite output under
`packages/desktop-ui/dist`. The renderer stays on `file://` because it is a
fully local, multi-entry UI (`index`, `mini`, `overlay`, and `pet`) and all
privileged work already crosses the context-isolated preload bridge. A custom
scheme would add protocol registration, routing, and CSP surface without an M2
capability benefit.

Development is intentionally different and honest: `bun run electron:dev`
starts the ordinary Vite server at `http://127.0.0.1:57314`, waits for that
URL, and launches the stock Electron binary with `--dev`. Isolated checkouts
can override the loopback URL with `STELLA_DEV_SERVER_URL`. There is no
bundle rename, Info.plist rewrite, icon swap, re-sign, responsibility-disclaim
shim, generated supervisor markers, or generated dev-URL file.

## Runtime sidecar and packaged binaries

The Electron main/preload code lives in ASAR. The Bun sidecar does not: the
build copies the compiled runtime to `Contents/Resources/runtime`, where an
external process can read it, and copies the build machine's Bun and ripgrep
binaries to `Contents/Resources/bin`. `STELLA_BUN_PATH` and
`STELLA_APP_RESOURCES_PATH` are set before runtime initialization. The host
therefore spawns the bundled Bun against the packaged worker entry and attaches
over its existing Unix-domain socket transport.

Most worker dependencies are bundled into the runtime chunks. `undici` and
`@silvia-odwyer/photon-node` remain installed-file-layout dependencies and are
copied beside the worker under `Contents/Resources/node_modules` (Photon needs
its adjacent WASM file). The social-session preview manager launches
`process.execPath`, which is that same bundled Bun inside the worker, for both
`bun install` and `bun x vite`; it does not depend on the user's PATH.

## Process ownership

The worker remains detached while Electron is running so an internal renderer
or host restart can reattach without losing active work. A true application
quit explicitly stops it. Worker shutdown stops the social-session service,
which terminates each Vite process group with a bounded TERM-to-KILL grace.
Normal quit therefore owns Electron, Bun, and every social preview child.
On macOS it also terminates this app instance's detached crashpad handler
after the last reporting client closes, so repeated launches cannot accumulate
orphaned helpers.

## Public service configuration

Connected builds supply `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` at Vite
build time. They are public service locations, not credentials. An
unconfigured local package still mounts the offline shell and Bun runtime; its
cloud-backed auth and synchronization features stay unavailable until those
public URLs are supplied. Electron-main public configuration is baked from
`packages/desktop/config/app-config.json`; the app never reads or writes a
source-checkout environment file at runtime.

## M2 signing

macOS M2 builds use ad-hoc identity `-`, including the copied Bun and ripgrep
binaries. This proves the signed bundle shape locally but is not distribution
signing. Developer ID, hardened runtime/entitlements, notarization, Windows
code signing, and CI credential wiring remain M4/human-checklist work.
