# iOS

The iOS path builds and drives Stella on the iOS Simulator on the user's Mac. One helper, `.agents/skills/verify-stella/scripts/control-stella-ios.sh`, works in two transports and picks one itself:

- **On the Mac** (`uname` is Darwin): every command runs locally. The Mac repo is the checkout the helper lives in.
- **From Linux**: commands reach the Mac over the `stella-mac` SSH alias, and the Mac repo is `/Users/rahulnanda/projects/stella-v2`. Do not use the Mac's LAN IP or add another transport.

`STELLA_IOS_SSH_HOST` forces SSH to a named host; `STELLA_IOS_MAC_REPO` overrides the Mac repo. `doctor` and `info` print the transport in use. When SSH is refused (Remote Login off on the Mac), run the work on the Mac itself instead, e.g. as an agent on that device.

It is local verification infrastructure. Cloud environments cannot reach it; report that as a blocker.

## Sub-features

- `ios-doctor` proves the transport, Mac repository, Bun, Xcode, runtime, and simulator inventory are usable.
- `ios-semantic-drive` uses the project-scoped XcodeBuildMCP bridge to inspect the accessibility tree and interact by current element references.
- `ios-stage` copies the current working-tree snapshot into a disposable directory on the Mac without touching the developer checkout.
- `ios-build` generates, builds, installs, and launches the Expo development build on the booted simulator, pointed at the dev backend. `--metro-only` instead serves JS to an already-installed development build.
- `ios-sign-in` signs the development build into a dev test account.
- `ios-drive` captures visible state and, when macOS Accessibility permission is available, sends deliberate input to the foreground Simulator window.
- `ios-proof` preserves simulator screenshots and relevant logs in the local skill directory.

## How to get to it (user POV)

- Launch Stella from its icon in an iPhone Simulator.
- Open a Stella deep link with `open-url` when a feature has a stable route.
- Interact with the foreground Simulator window for flows that require taps or typing.

## Driving it with control-stella-ios

Preconditions:

- Run from a stella-v2 checkout (Linux or the Mac). The Mac has Xcode with an available iOS Simulator runtime, Bun under `~/.bun/bin`, and Node.
- `STELLA_ADMIN_API_SECRET` is exported or set in the gitignored `workers/cloud-builder/.dev.vars` of the checkout you run from. Only `sign-in` needs it.
- Codex loads the project-scoped XcodeBuildMCP server from `.codex/config.toml` (`scripts/xcodebuildmcp-stella-ios.sh`, which also runs locally on the Mac or over SSH from Linux). After adding or changing that file, restart the Codex task before expecting XcodeBuildMCP tools to appear. Other agents can drive the same server with `npx -y xcodebuildmcp@2.7.0` on the Mac, or use the helper's `frame`, `open-url`, and coordinate commands.
- Never reset, clean, pull, switch, or overwrite the developer checkout on the Mac. `stage` creates a separate `/tmp/stella-ios-verify.*` source tree from `git ls-files`, including untracked non-ignored files and excluding ignored credentials and build products.

Commands below are relative to the repo root (`H=.agents/skills/verify-stella/scripts/control-stella-ios.sh`).

- **Doctor.** `$H doctor`. Require `transport=…`, Xcode 26.2 or newer, at least one available iPhone simulator, the Mac repo, Bun, Node, XcodeBuildMCP, and `semantic_input=yes`. A dirty Mac checkout is information, not permission to modify it. `mcp-doctor` is the shorter XcodeBuildMCP-only check. `screen_input=no` affects only the coordinate fallback.
- **Stage current source.** `$H stage`. Run it again after local source changes, after `clean-source`; do not layer a new snapshot over an old one. If `stage` says a staged source already exists and `info` shows a snapshot you did not create, leave it and ask, or `clean-source` only once you know it is abandoned.
- **Boot.** `$H boot [udid]`. The helper records whether it booted the device so cleanup does not shut down a simulator it did not start.
- **Build and launch.** `$H build` in a dedicated long-running terminal session. It sources `packages/mobile/.env.local` from the Mac repo (never copied into the stage, never printed), forces `EXPO_PUBLIC_STELLA_BACKEND_URL` to the dev backend (`STELLA_BACKEND_URL` overrides), runs `bun install --frozen-lockfile` and `i18n:sync` in the stage, then `expo run:ios` on the booted UDID. Expo builds, installs, launches, and keeps Metro attached; keep that session while driving. The first native build takes several minutes. `--no-bundler` only when a separate Metro already serves the same stage.
- **Disk floor.** A native `build` refuses below 30 GB free on the Mac and tells you to use `--metro-only`; `STELLA_IOS_MIN_FREE_GB` moves the floor. The floor exists because a native build has filled this Mac's disk, which breaks every tool on it, not just the build.
- **JS-only changes on a tight disk.** `$H build --metro-only [--port <port>]` installs dependencies and serves Metro from the stage without compiling anything, so an already-installed development build can run the staged JS. Pick a port no other agent is on (`lsof -nP -iTCP -sTCP:LISTEN`); 8081 is usually taken. A plain React Native debug build reads its packager from the `RCT_jsLocation` default, so point it at the stage with `xcrun simctl spawn <udid> defaults write com.stella.mobile RCT_jsLocation -string "localhost:<port>"` and relaunch; Metro then logs that device's bundle request and `console` output, which is how you confirm the device is running the staged tree. A build that embeds `expo-dev-client` takes `stella-mobile://expo-development-client/?url=<encoded>` instead.
- **What `--metro-only` cannot prove.** The installed binary is still the native app someone else built. Deep links have been observed not reaching the router in a reused binary — `stella-mobile://onboarding` and `stella-mobile://dev-test-session?ott=…` both left the app on its normal start screen while the device log showed `UIOpenURLAction` arriving. Anything that enters through a `stella-mobile://` link, `sign-in` included, needs a native build of the tree under test; report it as blocked rather than reading a non-navigation as a refusal.
- **Sign in.** `$H sign-in [--plan pro|go|free] [--email <name>@test.stella.local]` (default `pro`, a fresh account each time; `STELLA_VERIFY_ACCOUNT_EMAIL` reuses one). It mints a dev test account, then opens `stella-mobile://dev-test-session?ott=<one-time token>` in the booted simulator. Output is `email`, `owner_id`, and `plan`; no credential is printed. The app shows "Test-account sign-in", exchanges the token, and routes on to onboarding (fresh account) or the main shell. A refusal stays on that screen with the reason (`dev-test-session-refused`). Requires a running development build from `build`; a release, TestFlight, or OTA build always refuses. It also requires a cloud-builder deployed to the dev backend that returns `oneTimeToken` from `/api/admin/test-accounts/session`; when that field is missing the helper says so and the deploy, not the app, is the blocker.
- **Launch an installed build.** `$H launch` launches `com.stella.mobile` on the booted simulator.
- **Deep link.** `$H open-url '<stella-mobile://...>'` only with a route supported by the app.
- **Inspect.** Call XcodeBuildMCP `session_set_defaults` once with the booted simulator UDID, then `snapshot_ui` before interacting. Do not persist the machine-local UDID. Pair the semantic snapshot with a framebuffer capture: `$H frame --path .agents/skills/verify-stella/artifacts/ios/<feature>-before.png`.
- **Interact semantically.** Prefer XcodeBuildMCP `tap`, `type_text`, `swipe`, and `wait_for_ui`, using only an `elementRef` from the latest `snapshot_ui` or `wait_for_ui`. Refresh after navigation, scrolling, sheets, or layout changes; element refs are not durable selectors. A visible control missing from the snapshot is a product accessibility gap; use the coordinate fallback only to continue the current verification.
- **Coordinate fallback.** Only when doctor reports `screen_input=yes`: `$H screen --path .agents/skills/verify-stella/artifacts/ios/mac-screen.png`, find the Simulator window, then `click <x> <y>`, `type '<text>'`, or `key <name>`. The helper activates Simulator before input and fails closed without Accessibility permission. Recapture after every state transition.
- **Logs.** `$H logs` after a crash, blank screen, or failed transition. Pair the excerpt with a framebuffer screenshot.
- **Proof.** Capture the action state and resulting state as separate framebuffer images under `.agents/skills/verify-stella/artifacts/ios/<feature>/`. A successful build or launch alone is not UI proof. For mutations, reopen the screen or relaunch the app and read the value back.
- **Cleanup.** Stop the attached `build` session, then `$H shutdown` and `$H clean-source`. Cleanup removes only the helper-booted simulator state and its exact `/tmp/stella-ios-verify.*` snapshot, and preserves proof artifacts.

## Gotchas

- From Linux, the Mac and Linux checkouts can be on different commits. Always stage the tree you mean to verify.
- `.run/ios-*` state lives in the checkout you run the helper from. Linux and Mac runs do not see each other's staged source or booted simulator records.
- Simulator framebuffer screenshots exclude macOS window chrome and cannot locate desktop click coordinates. Use `screen` for coordinates and `frame` for app evidence.
- XcodeBuildMCP starts in `/tmp` so it never builds from or writes to the developer checkout. Pass staged source paths explicitly.
- A visible React Native control without an accessibility role or label may appear as text but not as an actionable XcodeBuildMCP target. Add stable accessibility metadata to the product instead of encoding a coordinate.
- `cliclick` is coordinate-based and needs macOS Accessibility permission. Click once, then inspect again; never replay coordinates after the UI changes.
- The simulator is shared. Use one booted device per run and do not erase, delete, or reset simulators. Several agents can be on this Mac at once: check `xcrun simctl list devices booted` and take a device nobody else is driving (`$H boot <udid>`), since `simctl … booted` is ambiguous with two devices up. The helper targets the UDID it recorded, not `booted`. To get a development build onto a second device without rebuilding, copy the installed bundle (`xcrun simctl get_app_container <other-udid> com.stella.mobile`) and `xcrun simctl install <your-udid> <path>`.
- A test account is real dev-backend state. `sign-in` creates a new owner each time unless you pass `--email` or `STELLA_VERIFY_ACCOUNT_EMAIL`.
- Apple sign-in, Google OAuth, camera hardware, push delivery, and paid-provider behavior may be unreachable in Simulator. Use `sign-in` for an authenticated state; report an OAuth-specific claim as blocked rather than substituting the test-account path.
