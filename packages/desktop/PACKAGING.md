# Desktop packaging and updates (M2-M4)

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

The product and development app name are explicitly `Stella`; internal
workspace names such as `@stella/desktop` never become the visible application
or Safe Storage name. On macOS that keeps development compatible with the
normal `Stella Safe Storage` Keychain service used by credentials in the shared
home. The dev launcher strips inherited source/install paths and ignores the
generic `STELLA_DATA_DIR`; only the explicit isolated-v2 override below can select
another home.

Packaged builds and ordinary `bun run electron:dev` launches both use
`~/.stella` for `stella.sqlite`, memories, skills, prompts, connectors, agent
configuration, media, and other user-owned files, matching the v1 home layout.
Electron `userData` is `~/.stella/electron-user-data` in both modes. Sharing
that path is intentional: Electron's process-singleton lock prevents v1 and v2
from concurrently owning the same home. V2 acquires that lock before it creates
the local transcript service or opens SQLite. Caches, Chromium/session state,
window state, updater state, detached-worker control files, and diagnostics
remain under that replaceable `userData` subtree. POSIX sockets use a short,
owner-only per-user namespace under `/tmp` to stay within platform socket-path
limits.

Isolated development launches can opt into a separate home with
`STELLA_V2_DEV_DATA_DIR`; its `electron-user-data` subtree and instance lock
stay isolated with it. Overrides are rejected if they overlap or alias the
normal `~/.stella` home. Destructive `bun run reset` and `bun run reset:sql`
commands require this explicit override and will not default to the shared
home.

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

## Desktop v2 update-channel isolation

Stella v1 and v2 intentionally retain the same `com.stella.app` app ID, so the
feed—not the bundle ID—is the hard update boundary. V2 uses all three of these
independent guards:

- only `desktop-v2-v*` tags trigger the v2 desktop workflow, and its first job
  rejects anything except an exact stable `desktop-v2-vX.Y.Z` tag;
- every R2 write is guarded under `desktop-v2/**`; the workflow never writes
  `desktop/**`, `desktop/current.json`, or any launcher path;
- the packaged client pins the generic provider to
  `desktop-v2/stable/<platform>` and channel `latest-v2`. The main process
  rejects a feed URL outside a `/desktop-v2/` path before `electron-updater`
  starts. Platform directories are `mac-arm64`, `mac-x64`, and `win-x64`, so
  independently built metadata files cannot overwrite another architecture.

The updater's local payload cache is also explicitly named
`stella-v2-updater`, avoiding the package-name-derived cache and keeping it
separate from v1 updater state.

`package.json` contains the matching generic-provider URL template. The
production runtime pins the same base in code and has no CLI or environment
override. The loopback verifier is a separate, verifier-only Electron entry
bundle that is excluded from normal production builds. It requires the exact
test product name, bundle ID, signed package metadata marker, explicit verifier
flag, and a `127.0.0.1/desktop-v2/` feed before it starts.

## Signing and notarization

The macOS release configuration enables hardened runtime. The parent app uses
its own audio-input entitlement, while nested Electron helpers use a separate
inherit file for JIT, executable-memory, and library-validation exceptions. CI
imports the existing
Developer ID certificate using the launcher's secret names
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and
`APPLE_SIGNING_IDENTITY`. The `afterSign` hook submits the signed `.app` with
`@electron/notarize` using `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`;
CI then verifies the signature, stapled ticket, and Gatekeeper assessment.
Missing signing or notarization credentials are fatal in CI. Local builds skip
notarization when credentials are absent.

Windows NSIS artifacts are intentionally unsigned in M4. The workflow disables
certificate auto-discovery and asserts `Get-AuthenticodeSignature` returns
`NotSigned`, matching the accepted SmartScreen warning. To add DigiCert later,
store its certificate or KeyLocker credentials as GitHub secrets, map them to
electron-builder's Windows signing inputs (for a PFX, `WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD`), remove the intentional `NotSigned` assertion, and add
an Authenticode verification step that requires a valid trusted signature.

## Local updater verification

`bun run updater:verify-local` prepares a verifier-only packaged app, builds two ad-hoc
versioned macOS ZIP releases in a temporary directory, serves the newer
`latest-v2-mac.yml` and payload from a loopback
`desktop-v2/stable/<platform>` feed, and launches the older app with isolated
Electron user/session/cache state, a verification-only bundle ID, signed package
metadata marker, and Electron's mock macOS Keychain. Normal production bundles
do not contain the verifier entry point, and the production updater refuses
loopback URLs unconditionally. The verifier sets `autoInstallOnAppQuit=false`,
detects and downloads the new version, validates the generated metadata, and
then quits without applying it. The ad-hoc harness never calls `quitAndInstall`:
Squirrel.Mac requires the replacement app to satisfy the installed app's real
signing requirement, so restart/apply is the final Developer-ID-signed CI gate.
No login Keychain item, R2 object, GitHub
repository, installed Stella app, or live v1 feed is read or modified by this
verification. Its dedicated updater and ShipIt caches are removed when the run
ends.

## Human release gates

M4 stops locally. To run the real release:

1. Create the `stella-v2` GitHub repository, add it as `origin`, and push
   `main`. Do not reuse the v1 repository's desktop tag namespace.
2. Add GitHub Actions secrets with the launcher's existing names:
   `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
   `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and
   `APPLE_TEAM_ID`; and v2 R2 credentials named `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `R2_ENDPOINT`. The R2 principal
   should be least-privilege for the v2 desktop and retained binary-pin
   prefixes and must not be used to write the v1 `desktop/**` namespace.
3. Add public repository variables `VITE_CONVEX_URL` and
   `VITE_CONVEX_SITE_URL` for connected release builds. Confirm the configured
   R2 public base URL serves byte ranges and exposes only the intended
   `desktop-v2/stable/<platform>` feeds to this client.
4. Run the retained native-helper and Stella Browser workflows first so their
   immutable manifests contain `darwin-arm64`, `darwin-x64`, and `win-x64`.
5. Push an exact stable `desktop-v2-vX.Y.Z` tag. Confirm Developer ID signing,
   notarization, stapling, Gatekeeper assessment, unsigned-Windows assertion,
   R2 publication, and GitHub Release creation all pass.
6. On an isolated test account or machine—not Rahul's live install—install an
   older signed v2 build, publish a newer signed v2 build, and prove the pill
   downloads, quits, installs, and relaunches the newer version. Verify the
   macOS Keychain prompt disappears on the first real Developer-ID-signed and
   notarized build. Run a signed-build microphone smoke test covering voice and
   dictation permission plus actual audio capture. Record that the v1 feed and
   `desktop/current.json` are byte-for-byte unchanged before and after this
   test.
7. On the same isolated machine, run negative cross-channel checks: prove an
   installed v1 client cannot discover or consume the v2 feed, and prove an
   installed v2 client cannot discover or consume the v1 feed.
8. Windows stays unsigned for M4. To add DigiCert later, configure the chosen
   PFX or KeyLocker credentials, remove `CSC_IDENTITY_AUTO_DISCOVERY=false`
   and the `NotSigned` assertion, wire electron-builder's signing inputs, and
   require a trusted Authenticode result before publication.
