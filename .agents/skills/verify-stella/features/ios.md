# iOS

The iOS path builds and drives Stella on the iOS Simulator installed on the user's Mac, reached from this Linux machine through the existing `stella-mac` SSH alias. It is local verification infrastructure. Do not add another network transport or replace the SSH alias.

## Sub-features

- `ios-doctor` proves the SSH target, Mac repository, Bun, Xcode, runtime, and simulator inventory are usable.
- `ios-semantic-drive` uses the project-scoped XcodeBuildMCP bridge to inspect the accessibility tree and interact by current element references.
- `ios-stage` copies the current Linux working-tree snapshot into a disposable directory on the Mac without touching the developer checkout.
- `ios-build` generates, builds, installs, and launches the Expo development build on a named simulator.
- `ios-drive` captures visible state and, when macOS Accessibility permission is available, sends deliberate input to the foreground Simulator window.
- `ios-proof` preserves simulator screenshots and relevant logs on Linux.

## How to get to it (user POV)

- Launch Stella from its icon in an iPhone Simulator.
- Open a Stella deep link with `xcrun simctl openurl` when a feature has a stable route.
- Interact with the foreground Simulator window for flows that require taps or typing.

## Driving it with control-stella-ios

Preconditions:

- Run from the Stella repository on the Linux machine.
- `ssh stella-mac` resolves through the user's SSH config. Do not use the Mac's LAN IP directly.
- The Mac checkout is `/Users/rahulnanda/projects/stella-v2`, Bun is `/Users/rahulnanda/.bun/bin/bun`, and Xcode owns an available iOS Simulator runtime.
- Codex loads the project-scoped server from `.codex/config.toml`. After adding or changing that file, restart the Codex task before expecting XcodeBuildMCP tools to appear.
- Never reset, clean, pull, switch, or overwrite the developer checkout on the Mac. The helper's `stage` command creates a separate `/tmp/stella-ios-verify.*` source tree from `git ls-files`, including untracked non-ignored files and excluding ignored credentials and build products.

- **Doctor.** Run `.agents/skills/verify-stella/scripts/control-stella-ios.sh doctor`. Require successful SSH, Xcode 26.2 or newer, at least one available iPhone simulator, the Mac repo, Bun, Node, XcodeBuildMCP, and `semantic_input=yes`. Treat a dirty Mac checkout as information, not permission to modify it. Use `mcp-doctor` for the shorter XcodeBuildMCP-only readiness check. `screen_input=no` affects only the coordinate fallback; semantic XcodeBuildMCP input does not depend on the Mac Simulator window position.
- **Stage current source.** Run `.agents/skills/verify-stella/scripts/control-stella-ios.sh stage`. Use the returned disposable path for every build command. Run `stage` again after local source changes; do not layer a new snapshot over an old one.
- **Boot.** Run `.agents/skills/verify-stella/scripts/control-stella-ios.sh boot`. Pass a UDID to choose a particular available simulator. The helper records whether it booted the device so cleanup does not shut down a simulator it did not start.
- **Build and launch.** Read the staged path with `.agents/skills/verify-stella/scripts/control-stella-ios.sh source`. In a dedicated terminal session, run `ssh -t stella-mac "export PATH=/Users/rahulnanda/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; export LANG=en_US.UTF-8; export LC_ALL=en_US.UTF-8; set -a; source /Users/rahulnanda/projects/stella-v2/packages/mobile/.env.local; set +a; cd '<staged-path>'; bun install --frozen-lockfile; cd packages/mobile; bun run i18n:sync; bunx expo run:ios --device '<udid>'"`. The environment file stays in the developer checkout and is used only by the remote process; do not copy it into the staged tree or print its values. Expo generates `ios/` when absent, builds the native app, installs it, launches it, and keeps Metro attached. Keep that terminal session while driving. Use `--no-bundler` only when a separate Metro process is already serving the same staged tree.
- **Launch an installed build.** Run `.agents/skills/verify-stella/scripts/control-stella-ios.sh launch`. This launches `com.stella.mobile` on the booted simulator.
- **Deep link.** Run `.agents/skills/verify-stella/scripts/control-stella-ios.sh open-url '<stella-mobile://...>'` only with a route supported by the app.
- **Inspect.** Call XcodeBuildMCP `session_set_defaults` once with the booted simulator UDID, then call `snapshot_ui` before interacting. Do not persist the machine-local UDID. Pair the semantic snapshot with a framebuffer capture from `.agents/skills/verify-stella/scripts/control-stella-ios.sh frame --path .agents/skills/verify-stella/artifacts/ios/<feature>-before.png` as product evidence.
- **Interact semantically.** Prefer XcodeBuildMCP `tap`, `type_text`, `swipe`, and `wait_for_ui`. Use only an `elementRef` advertised for that action by the latest `snapshot_ui` or `wait_for_ui` result. Refresh the snapshot after navigation, scrolling, sheet changes, or visible layout changes; element refs are not durable selectors. Prefer an accessibility label, role, or identifier when waiting for state. If a visible control is absent from the semantic snapshot, treat that as a product accessibility gap and use the coordinate fallback only to continue the current verification.
- **Coordinate fallback.** Only when doctor reports `screen_input=yes`, capture the whole Mac screen with `.agents/skills/verify-stella/scripts/control-stella-ios.sh screen --path .agents/skills/verify-stella/artifacts/ios/mac-screen.png`. Require the Simulator window to be visibly present, inspect the image, and identify coordinates inside it. Then use `click <x> <y>`, `type '<text>'`, or `key <name>`. The helper activates Simulator immediately before input and fails closed when Accessibility permission is absent. Recapture after every state transition; coordinates are never reusable proof. If the Simulator window is absent from the screen capture, use semantic input, deep links, and framebuffer proof or report that interactive entry point as unavailable.
- **Logs.** Run `.agents/skills/verify-stella/scripts/control-stella-ios.sh logs` after a crash, blank screen, or failed transition. Pair the relevant log excerpt with a framebuffer screenshot.
- **Proof.** Capture the action state and resulting state as separate framebuffer images under `.agents/skills/verify-stella/artifacts/ios/<feature>/`. A successful build or process launch alone is not UI proof. For mutations, reopen the affected screen or relaunch the app and read the value back.
- **Cleanup.** Stop the attached Expo session, then run `.agents/skills/verify-stella/scripts/control-stella-ios.sh shutdown` and `.agents/skills/verify-stella/scripts/control-stella-ios.sh clean-source`. Cleanup removes only the helper-booted simulator state and its exact `/tmp/stella-ios-verify.*` snapshot. It preserves Linux proof artifacts.

## Gotchas

- The Mac and Linux checkouts can be on different commits. Always stage the Linux tree when verifying current local work.
- Simulator framebuffer screenshots do not include the macOS window chrome and cannot locate desktop click coordinates. Use `screen` for coordinate selection and `frame` for app evidence.
- XcodeBuildMCP runs on the Mac over SSH stdio, but starts in `/tmp` so it does not implicitly build from or write to the developer checkout. Pass staged source paths explicitly for any project/build tool.
- A visible React Native control without an accessibility role or label may appear as text but not as an actionable XcodeBuildMCP target. Add stable accessibility metadata to the product instead of encoding a permanent coordinate.
- `cliclick` is coordinate-based and requires macOS Accessibility permission. Activate Simulator, inspect a fresh screen capture, click once, and inspect again. Never replay a coordinate sequence after the UI changes.
- The simulator is a shared physical resource. Use one booted device per verification run and do not erase, delete, or reset simulators.
- Native builds can take several minutes. Keep the build session attached and read its output instead of starting duplicate builds.
- Sign-in, Apple account state, camera hardware, push delivery, and paid-provider behavior may be unreachable in Simulator. Report the exact blocked entry point rather than substituting an internal API call.
