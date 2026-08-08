# CarPlay v2 — dead-tap fix + voice home rebuild

Working notes kept commit-by-commit so the outcome survives an interrupted
agent run. Base: `475c077` ("Fix CarPlay blank screen on connect", build 91).

## Dead-tap root cause (item 0)

On build 91 the head unit *renders* (the native placeholder installed by
`StellaCarSceneDelegate`) but tapping "Talk to Stella" does nothing:

1. **The visible row was inert by design.** The native placeholder
   `CPListItem` in `mobile/plugins/withStellaCarPlay.js`
   (`StellaCarPlayInstallPlaceholder`) was created with **no `handler`** — so
   whenever the JS root-template takeover doesn't land, the driver is looking
   at a dead row.
2. **The JS takeover is fragile on real hardware.** Three concrete failure
   modes, all silent before this fix:
   - `RNCarPlay.connectWithInterfaceController` (node_modules
     `ios/RNCarPlay.m` connect path) emits `didConnect` through
     `RCTEventEmitter`; when the JS listener isn't registered yet (cold launch
     by the car, JS bundle still booting), the event is **dropped with zero
     listeners** and nothing re-delivers it except a later
     `checkForConnection()` — a single-shot race.
   - `RCT_EXPORT_METHOD(setRootTemplate:)` (`ios/RNCarPlay.m:463` pre-patch)
     failed **silently** (`NSLog(@"error %@", err)` only, no retry): one failed
     or raced `setRootTemplate` against the just-installed native placeholder
     leaves the placeholder up forever.
   - Stella's JS session rebuilt its templates on every `didConnect`;
     `Template`'s constructor registers NativeEventEmitter listeners keyed by
     the fixed template id and **never removes them**, so reconnect replays
     stacked duplicate `onItemSelect` handlers.

### Fix (commit `8148548`)

- Native placeholder row got a real `CPListItem.handler`: logs the tap and
  force-retries the JS takeover by re-running
  `[RNCarPlay connectWithInterfaceController:window:]` (re-emits
  `didConnect`); row detail text shows "Connecting to Stella..." and after 4
  failed retries "Still connecting — open Stella on your iPhone".
- Native watchdog re-checks `interfaceController.rootTemplate` at 2/6/12/20s
  after connect and re-emits `didConnect` while the root is still the
  placeholder.
- `react-native-carplay@2.3.0` patch extended: `connect`,
  `checkForConnection`, and `setRootTemplate` (template found/missing +
  completion done/error) now log to the shared `StellaCarPlayDiagnostics`
  user-defaults store and Console with the `[carplay]` prefix.
- JS session (`mobile/src/carplay/carplay-session.ts`): `carPlayLog()` writes
  JS breadcrumbs into the same user-defaults store via RN `Settings`;
  `setRootTemplate` re-asserted at +1s/+3s; `checkForConnection` polled every
  2s (max 15) until connected; templates built once per app lifetime so
  retried connects can't double-fire item selects.

## v2 voice home spec status

| # | Item | Status | Commit |
|---|------|--------|--------|
| 0 | Dead-tap fix + takeover hardening | done | `8148548` |
| 1 | Tap to talk / tap to stop (single-list home) | done | `dda5e01` |
| 2 | Recent assistant messages, tap to read | done | `eac344d` |
| 3 | New-message indicator + relative timestamp | done | `b10f212` |
| 4 | Read-latest button | done | `ea9aeb4` |
| 5 | Converse mode (auto-read toggle, default ON) | done | `9fc6661` |
| — | Docs + dictation/TTS breadcrumbs | done | (this commit) |

## v2 design in one line

ONE `CPListTemplate` root, no template-stack transitions: the
`CPVoiceControlTemplate` overlay and pushed `CPNowPlayingTemplate` from v1 are
gone (each transition was another way to strand the driver on a surface
without a working tap). Rows: **Talk to Stella** (tap to talk, tap to stop +
send, barge-in while speaking), **Read latest reply** (hidden until a reply
exists), **Converse mode: On/Off**, and a **Recent replies** section (newest
2, relative timestamps, "New · <time>" marker until heard, tap reads that
message).

Code: `mobile/src/carplay/carplay-home.ts` (pure row builders, bun-tested),
`carplay-session.ts` (imperative template controller + takeover hardening +
`carPlayLog`), `CarPlayBridge.tsx` (drives useDictation / useChatThread
"carplay" transcript / speakReply). Flat tap indexes (RNCarPlay reports item
selection as a flat index across sections) map to typed row actions.

## Verified vs needs-on-car

Verified off-device:
- `bun test src/carplay` — 20 tests on the row builders (phase copy, reply
  rows, timestamps, new-marker, read-latest visibility, converse states, flat
  action order).
- `bunx tsc --noEmit` clean; `expo prebuild -p ios` regenerates the scene
  delegate; generated `StellaCarSceneDelegate.m` syntax-checked with
  `xcrun clang -fsyntax-only` against the iphonesimulator SDK — 0 errors (only
  the pre-existing `initWithText:` deprecation warning).

Needs on-car validation (Simulator CarPlay unusable on this machine —
Accessibility/SIP gating):
- Placeholder tap handler + watchdog actually recovering the JS takeover on
  the real head unit (and whose diagnostics line reveals the true first-order
  failure: dropped didConnect vs. silent setRootTemplate vs. JS exception).
- Voice loop end-to-end (dictation route via CarPlay audio, TTS playback
  through the car), row updates while driving, converse-mode loop.
- After a drive, dump `StellaCarPlayDiagnostics` (native + `[js]` lines
  interleaved) or filter Console.app on `[carplay]`.

Build 92 to be cut by Rahul after review — nothing pushed, no build run.

---

# Build-92 field report (real car): stuck on placeholder — analysis

Observed: placeholder renders, detail text reached **"Still connecting — open
Stella on your iPhone"**, tap does nothing visible, force-quit/reopen and
unplug/replug don't recover.

What that tells us for free:
- The native side is fully healthy: scene delegate ran, placeholder installed,
  the **tap handler and watchdog fired** (that detail text only appears after
  ≥4 takeover retries), `gInterfaceController` was live, and
  `[RNCarPlay connectWithInterfaceController:]` was re-invoked repeatedly.
- JS never set its root **even with the app foregrounded on the phone** →
  this is a *deterministic* JS/bridge-side failure, not a headless-launch or
  timing race.

## Ranked suspects (with the breadcrumb signature each leaves)

1. **`RCTEventEmitter.sendEventWithName` silently drops the event while
   `_listenerCount == 0`** (`node_modules/react-native/React/Modules/RCTEventEmitter.m`,
   `shouldEmitEvent = _observationDisabled || _listenerCount > 0`, else
   RCTLogWarn-and-drop). Under bridgeless New Arch the legacy RNCarPlay module
   is reached via the interop layer; if its `addListener` bookkeeping doesn't
   reach the native module instance, **every** emit (didConnect AND
   didSelectListItem) is dropped forever — exactly matches "retries change
   nothing, relaunch changes nothing".
   *Signature:* native lines incl. `RNCarPlay.connect ... callableJSModules=YES`
   and `checkForConnection called from JS; storeConnected=YES` +
   `re-emitted didConnect`, `[js] registered onConnect` + poll attempts — but
   **no `[js] JS connect handler running`**.
   → **Fixed defensively in `b70a187`**: the patch now overrides
   `sendEventWithName` in RNCarPlay to emit directly via
   `callableJSModules → RCTDeviceEventEmitter` (no listener-count guard;
   harmless no-op if JS listeners truly absent), with a breadcrumb per emit.

2. **`require("react-native-carplay")` throws on device** (e.g.
   `new NativeEventEmitter(NativeModules.RNCarPlay)` with a nil module if the
   interop layer didn't surface it in the release build). In build 92 this was
   swallowed by a console-only warn — invisible.
   *Signature (build 92):* **zero `[js]` lines at all**.
   *Signature (build 93, after `b70a187`):* `[js] CarPlayBridge mounted`,
   `session.register() called`, `NativeModules.RNCarPlay MISSING` /
   `require FAILED: ...`, `register() bailed`.

3. **JS receives didConnect but native `setRootTemplate` fails** (template
   missing from RNCPStore, stale/nil interfaceController, or CarPlay rejecting
   the template).
   *Signature:* `[js] JS connect handler running` + `setRootTemplate attempt`
   and then `setRootTemplate(stella-voice-home) template=MISSING` or
   `completion done=NO error=...` from the patched native module.

4. **CarPlayBridge never mounts** (env gating `hasMobileConfig`, a provider
   crash above it, or the React tree not rendering in the TestFlight build).
   Unlikely — the phone app itself works — but until build 93 it was
   indistinguishable from #2.
   *Signature (93):* native lines only, **no `[js] CarPlayBridge mounted`**.

5. **Patch not applied in the EAS build** (bun `patchedDependencies` skipped).
   Verified locally: `mobile/bun.lock` carries the
   `react-native-carplay@2.3.0 → patches/...` entry and EAS uses bun (bun.lock
   present), so this is low-probability.
   *Signature:* scene-delegate `[carplay]` lines present but **no
   `RNCarPlay.connect bridge=...` / `checkForConnection called from JS`
   lines** (those only exist in the patched module).

## Getting the breadcrumbs off Rahul's phone

The breadcrumb store (`StellaCarPlayDiagnostics` in NSUserDefaults)
**persists across app updates** — the lines from today's failed drive are
still on the phone.

Easiest (no cable, no Xcode): **install build 93 from TestFlight, then in
Stella: Account tab → "CarPlay diagnostics" → Copy all → paste into a
message.** Do this BEFORE connecting to the car again — the store keeps only
the latest 80 lines, and a new connect session will push old ones out.

Live alternative (needs Mac + cable, only shows logs while connected): plug
the iPhone into the Mac → open **Console.app** → select the iPhone in the
sidebar → press **Start streaming** → type `carplay` in the search box (top
right) and press return → reproduce in the car → screenshot/copy the lines.

## Fix/diagnostic commits (post-build-92)

- `b70a187` — bypass RCTEventEmitter listener-count drop (suspect #1 fix) +
  close the `[js]` breadcrumb blind spots (bridge mount, register entry/bail,
  NativeModules presence, require failures).
- `f9d82f4` — in-app CarPlay diagnostics screen (Account → CarPlay
  diagnostics: list, Copy all, Refresh, Clear).

Build 93 after Rahul reviews. Whatever the dump shows, the signature table
above maps it straight to the failing layer.

---

# Diagnostics verdict (real-car dump, build 93+): CULPRIT FOUND

The dump confirmed suspect #1's fix worked (`RNCarPlay.connect ...
callableJSModules=YES` → `[js] JS connect handler running` on every retry)
and exposed the real killer:

```
[js] JS connect handler FAILED: TypeError: Object is not a function
```

on every attempt, thrown between "connect handler running" and "templates
built" — i.e. inside `new ListTemplate()`.

**Root cause:** `react-native-carplay/lib/templates/Template.js:6`

```js
const resolveAssetSource = require('react-native/Libraries/Image/resolveAssetSource');
```

On RN 0.83 that file is an **ES module** (`export default resolveAssetSource`),
so the bare `require` returns the namespace object `{ default: fn }`.
`parseConfig` then calls it for every key matching `/[Ii]mage$/` — the talk
row's mic icon — throwing `TypeError: Object is not a function` in **every
template constructor and every `updateSections`**. Deterministic, device and
simulator alike; it simply had never been executed before the takeover
finally got this far. This is why the JS voice home has never rendered on
this RN version.

**Fix (commit `d7aab96`, pure JS → OTA):** `carplay-session.installParseConfigShim`
replaces `parseConfig` on the shared `Template` prototype at library load
with `parseTemplateConfig()` (`carplay-home.ts` — pure walker matching
upstream semantics: resolve `/[Ii]mage$/` keys at any depth via the public
`Image.resolveAssetSource`, JSON round-trip drops function props;
unit-tested). Plus granular breadcrumbs through the connect path
(`building home rows` → `constructing ListTemplate` → `ListTemplate
constructed` → `setRootTemplate attempt` → `rendering home rows`) so any
residual failure names its exact step.

---

# Post-OTA field crash (builds 95/96): SOLVED — RCTAppearance vs CarPlay scene

With the parseConfig shim live, the takeover SUCCEEDED end-to-end (breadcrumbs:
connect → templates → `setRootTemplate done=YES` → finished, 18:45:09), then
the whole app died ~4s later and the JS context restarted (18:45:13).

ASC crash log (retrieved via App Store Connect → TestFlight → Crashes,
submission Jul 2 11:42 AM, 1.0.17 (96), iPhone 13 Pro Max, iOS 26.5):

```
Exception Type:  EXC_CRASH (SIGABRT)
Exception Reason: -[CPTemplateApplicationScene windows]: unrecognized selector
6   React  -[RCTAppearance setColorScheme:] (RCTAppearance.mm:117)
10  React  ObjCTurboModule::performVoidMethodInvocation
```

**Root cause — NOT the images/shim:** RN's native
`RCTAppearance.setColorScheme:` iterates `UIApplication.connectedScenes` with
an unguarded `for (UIWindowScene *scene in ...)`; a CarPlay head unit adds a
`CPTemplateApplicationScene` (no `windows` selector) → uncaught NSException →
app-wide SIGABRT. Trigger: `src/theme/theme-context.tsx` applies the stored
theme via `Appearance.setColorScheme` shortly after JS boot — so **launching
(or crash-relaunching) with the car attached is a crash loop**. Crash log
timing (died 1.8s after launch) and breadcrumbs (theme storage loads seconds
after connect) both fit. Pre-shim builds "survived" only when the app was
already running with the theme settled before plugging in.

**Fixes:**
- `0088680` (pure JS → **OTA to 95/96**): `theme-context` now routes through
  `setColorSchemeSafely()` (`src/carplay/carplay-appearance.ts`) — defers the
  native call while CarPlay is connected, or likely connected at launch via a
  persisted `StellaCarPlayConnected` NSUserDefaults flag (sync-read; covers
  the theme-before-didConnect race and the crash-relaunch loop); applies
  1.5s after disconnect or after a 20s stale-flag grace. Policy is pure and
  bun-tested (`carplay-appearance-policy.ts`).
- `53fd04a` (native, **build 97**): `patches/react-native@0.83.6.patch` adds
  an `isKindOfClass:[UIWindowScene class]` guard in `RCTAppearance.mm` — the
  definitive fix.

**OTA ORDERING (important):** publish the OTA from `0088680`, NOT HEAD —
`53fd04a` changes `patches/` + `package.json`, which the expo fingerprint
hashes, so HEAD's fingerprint no longer matches builds 95/96. Then cut
build 97 from HEAD.

Confidence: high — exception type, crashing frame, trigger timing, and both
field sessions all line up; the JS guard prevents the only caller, and the
native patch removes the crash class entirely. Residual risk: cosmetic only
(native chrome may lag the JS theme while driving until build 97).

---

**Ship path: OTA.** The fix touches only
`mobile/src/carplay/{carplay-home,carplay-session}.ts` — no native code and
deliberately NOT the bun patch, because the expo-updates fingerprint hashes
the `patches/` dir; touching `patches/react-native-carplay@2.3.0.patch`
would change the fingerprint away from `6dd9124f…` and orphan builds 95/96.
Publish on the existing update channel; no build 97 needed. Expected healthy
breadcrumb tail after OTA: `installed parseConfig interop shim` … `ListTemplate
constructed` … `setRootTemplate(stella-voice-home) template=FOUND` …
`completion done=YES error=none` — and the voice home on the head unit.

**OTA publish ritual (2026-07-02 boot-crash postmortem).** The first attempt
to ship this fix was published from a DIRTY working tree: the bundle labeled
`cc5808e` actually carried a mid-refactor `ChatPane.tsx` (rendered
`<ActivityTray/>` with its import already deleted) that existed in NO commit —
release-mode `ReferenceError` on first render, instant crash on every launch
of builds 95/96, and expo-updates never fell back to the embedded bundle.
Never run `eas update` by hand again: use `mobile/scripts/publish-ota.sh
<channel>`, which refuses dirty trees, checks env, exports locally, and proves
via the Hermes sourcemap's `sourcesContent`
(`mobile/scripts/verify-ota-export.ts`) that every bundled first-party file
matches git HEAD byte-for-byte before publishing.
