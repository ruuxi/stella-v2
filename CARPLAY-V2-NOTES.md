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
