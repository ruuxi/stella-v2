# Stella v2 local testing

This repository is a local v2 test surface. It intentionally shares the
production `com.stella.app` bundle ID with Stella v1, so keep the two apps
separate and **never replace `/Applications/Stella.app`**.

## Development mode

The real Electron development command is `bun run electron:dev`. Run it with a
different loopback port and an explicit v2-only runtime directory:

```sh
cd /Users/rahulnanda/projects/stella-v2
mkdir -p "$HOME/.stella-v2-dev-test"
STELLA_DEV_SERVER_URL=http://127.0.0.1:57315 \
STELLA_V2_DEV_DATA_DIR="$HOME/.stella-v2-dev-test" \
bun run electron:dev
```

This starts Vite and Electron together. The port override is honored by both
the Vite server and Electron launcher. Development uses the separate visible
app name `Stella v2 Development` and does not inherit v1's `STELLA_DATA_DIR`.
Quit the terminal process with `Ctrl-C` when finished.

## Packaged macOS test build

The locally built app is staged at:

```text
~/Applications/Stella V2 Test/Stella.app
```

Before opening that copy, fully quit every other Stella instance. Do not drag it
onto the DMG's `/Applications` alias, do not copy it into `/Applications`, and
do not replace the daily-driver `/Applications/Stella.app`. The test copy has
the same bundle ID as production; it must be run by itself, not over the live
daily-driver process.

For a fully isolated terminal smoke boot, use a v2-only state directory and a
separate Chromium profile:

```sh
mkdir -p "$HOME/.stella-v2-packaged-test"
STELLA_DATA_DIR="$HOME/.stella-v2-packaged-test/runtime" \
"$HOME/Applications/Stella V2 Test/Stella.app/Contents/MacOS/Stella" \
  --user-data-dir="$HOME/.stella-v2-packaged-test/chromium"
```

Quit it normally after the first-run/auth screen appears. This command avoids
using v1's Stella runtime and Chromium profile. Do not set `STELLA_DATA_DIR`
for `/Applications/Stella.app`.

## Current capability checklist

- macOS: Developer-ID signing and hardened runtime are expected. Confirm with
  `codesign --verify --deep --strict --verbose=2 "$HOME/Applications/Stella V2 Test/Stella.app"`.
- macOS notarization: check `spctl -a -vv "$HOME/Applications/Stella V2 Test/Stella.app"`.
  Gatekeeper must report `accepted`; a local build without Apple notarization
  credentials is signed but not notarized.
- Public production Convex configuration is baked at renderer build time:
  `https://benevolent-minnow-586.convex.cloud` and `https://cloud.stella.sh`.
  The first-run/auth flow should therefore be online, not the offline-only
  shell.
- Keychain: real Developer-ID signing should eliminate the prior unsigned-build
  Keychain prompt. This remains a hands-on checklist item: after fully quitting
  v1, record whether a new prompt appears during the first signed-package boot.
  The July 17 local build verified the Developer-ID signature, but its normal
  isolated launch could not reach UI while v1 was running because Electron
  failed to reserve its V8 code range under machine memory pressure; this is
  not a successful keychain-prompt verification.
- Windows: the M4 artifact is intentionally unsigned; SmartScreen remains an
  expected gap.
- Updating: v2 has its own feed/channel protections, but local testing has no
  published update feed. End-to-end updater testing still requires the CI
  channel and two signed, published v2 builds.
