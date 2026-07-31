# Stella CarPlay — voice mode

A driving-safe, voice-first CarPlay experience for Stella. It is glance-free:
tap once, speak, and Stella records, transcribes, answers, and reads the answer
back aloud — the whole hands-free loop in the car.

## One surface (v2)

Stella ships exactly ONE CarPlay surface under the CarPlay **audio**
entitlement: a `CPListTemplate` voice home. v1 also presented a
`CPVoiceControlTemplate` overlay while listening and pushed a
`CPNowPlayingTemplate` replay card while speaking, but every template
transition proved to be another way for a real head unit to strand the driver
on a surface without a working tap (the build-91 dead-tap bug — see
`CARPLAY-V2-NOTES.md`). All state now renders into the list rows via
`updateSections`, which never touches the template stack.

The rows (top to bottom):

| Row | What it does |
| --- | --- |
| **Talk to Stella** | Tap to speak; tap again to stop and send. Shows "Listening…", "Stella is thinking…", "Stella is speaking" (+ reply preview) as the turn progresses. Tapping while Stella speaks interrupts the TTS and starts listening (barge-in). |
| **Read latest reply** | One tap reads the newest assistant reply aloud. Hidden until a reply exists (no dead taps). |
| **Converse mode: On/Off** | The hands-free loop. While ON (default), the reply to a dictated message auto-plays via TTS on arrival. While OFF, new replies are just marked on the list. State is always visible in the title. |
| **Recent replies** (section) | The newest assistant reply + the previous one, truncated to a glance-safe line with a relative timestamp ("now", "2m ago"). A reply that arrived since the driver last heard one shows "New · <time> — tap to hear it". Tapping a row reads THAT message aloud. |

The flow: **tap → record → tap → transcribe → send → await reply →
auto-speak (Converse mode) → rows update**.

## How it reuses existing Stella plumbing (no parallel paths)

Everything the car needs already existed in the app; CarPlay only wires it up:

- **Send + response** → `useChatThread` on the **cloud** transport (the exact
  `/api/mobile/offline-chat/stream` pipeline the Chat tab uses). It runs on a
  dedicated `"carplay"` transcript so the always-mounted CarPlay bridge never
  races the Chat tab's `"cloud"` store.
- **Dictation** → `useDictation` (the same `/api/mobile/transcribe`
  push-to-talk recorder the composer mic uses — including AI-consent and mic
  permission handling).
- **Text-to-speech** → `speakReply` from `src/lib/read-aloud.ts` (the same
  Inworld "Wendy" voice as the chat "read aloud" button), so replies in the car
  sound identical to the phone.

Wiring lives in:

- `src/carplay/carplay-home.ts` — pure row/section builders (no react-native
  imports) with the phase copy, previews, relative timestamps, and the flat
  tap-index → action mapping. Unit-tested with `bun test src/carplay`.
- `src/carplay/carplay-session.ts` — imperative controller that owns the list
  template, a small phase machine (`idle → listening → thinking → speaking`),
  the connect/takeover hardening (setRootTemplate retries, checkForConnection
  polling), and the `carPlayLog` diagnostics writer.
- `src/carplay/CarPlayBridge.tsx` — headless component (mounted in
  `app/_layout.tsx`, inside the Convex/auth providers) that drives the loop with
  the hooks above and binds tap callbacks to the session.

## Carrying Stella's design language into the templates

CarPlay only lets us use Apple's templates, so the brand lives in the levers we
control:

- **Stella green accent** — `assets/carplay/stella-voice-{mic,replay,listening}.png`
  are Stella-green glyphs (the palette's success/`ok` green) used as the talk
  row and read-latest row leading icons. Regenerate with
  `python3 assets/carplay/generate-icons.py`.
- **Naming + tone** — titles and labels match the phone app's voice
  ("Talk to Stella", "Stella is thinking…", "Stella is speaking", "Stella" as
  the template title), mirroring copy like "Ask Stella anything".

## Entitlement

CarPlay is entitlement-gated. Stella's App Store/TestFlight builds carry:

- **Entitlement:** `com.apple.developer.carplay-audio`
- **Category:** **Audio** (a voice assistant that records a request and reads
  the answer back aloud fits the audio / now-playing model).

The entitlement is declared in `app.json` and present in the EAS provisioning
profile. The CarPlay Simulator does **not** enforce entitlements, so simulator
testing can still pass even if a future provisioning profile drops the key; for
real-car regressions, verify the IPA's embedded entitlements with `codesign`.

## Native wiring (config plugin)

`ios/` and `android/` are gitignored (Continuous Native Generation), so the
native setup is a config plugin, `plugins/withStellaCarPlay.js`, registered in
`app.json`. On `expo prebuild` / EAS Build it:

1. Adds both required scene roles to `UIApplicationSceneManifest`:
   `UIWindowSceneSessionRoleApplication` for the phone window and
   `CPTemplateApplicationSceneSessionRoleApplication` for CarPlay.
2. Writes a Swift `StellaPhoneSceneDelegate` that attaches Expo's existing
   AppDelegate-created RN window to the phone scene.
3. Writes an Objective-C `StellaCarSceneDelegate` that immediately installs a
   native "Talk to Stella" `CPListTemplate` placeholder, then forwards the
   interface controller to `RNCarPlay` (react-native-carplay). JS replaces the
   placeholder when its connect handler runs. This avoids a blank head unit when
   CarPlay connects before RN/JS finishes registering its listener. The
   placeholder row has a real tap handler that force-retries the JS takeover
   (re-emits `didConnect`), and a watchdog re-checks the root template at
   2/6/12/20s after connect — so the placeholder is never a dead tap.
4. Adds those delegates to the Xcode Sources build phase.

## How to test in the CarPlay Simulator

CarPlay does **not** work in Expo Go — it needs a dev/prebuild build.

1. **Build the native iOS app** (needs Xcode + CocoaPods):
   ```bash
   cd mobile
   bunx expo prebuild -p ios           # applies the CarPlay config plugin
   bunx expo run:ios                   # builds + boots the app in the iOS Simulator
   ```
   (Or open `ios/Stella.xcworkspace` in Xcode and Run.)

2. **Open the CarPlay Simulator window:** in the **Simulator** app menu bar →
   **I/O → External Displays → CarPlay**. A CarPlay head-unit window appears.

3. **Launch Stella** from the CarPlay home screen. You should land on the
   **Voice home** list ("Talk to Stella").

4. **Drive the loop:** tap the talk row → it shows "Listening…" → tap again to
   send → "Stella is thinking…" → the reply is spoken aloud (Converse mode) and
   lands in **Recent replies**. Tap a reply row or **Read latest reply** to
   hear it again.

   Make sure the app is signed in (or in guest mode) and AI consent + microphone
   permission have been granted once on the phone first — those prompts surface
   on the phone, not the car screen.

> Tip: if the CarPlay menu item is missing, ensure you're on a recent Xcode and
> that the app built and launched in the phone Simulator at least once.

## Notes / gotchas

- **react-native-carplay** (2.3.0) is a legacy-arch RCTBridgeModule; it loads on
  the New Architecture via the interop layer. Stella replays an already-connected
  session after registering its JS callback, polls `checkForConnection()` until
  connected, and asserts `setRootTemplate` at +1.5s/+3.5s/+8s — never
  immediately — because on a real head unit the first `didConnect` can be
  emitted before the JS listener exists (the event is dropped with zero
  listeners) and a single `setRootTemplate` can fail silently. The deliberate
  delay before the FIRST attempt matters: JS's `setRootTemplate` installs
  `interfaceController.delegate = RNCarPlay`, and when the CarPlay scene
  attaches to an already-running app, an immediate JS root-set races the
  native placeholder's async `setRootTemplate` — the placeholder then appears
  with a live delegate, RNCarPlay's `templateWillAppear` reads its missing
  `userInfo.templateId`, and `setObject:nil` aborts the whole app
  (the build-97 "phone open first, then CarPlay" crash).
- **Templates are built once per app lifetime.** `react-native-carplay`'s
  `Template` constructor registers NativeEventEmitter listeners keyed by the
  fixed template id and never removes them; rebuilding on each connect would
  stack duplicate `onItemSelect` handlers.
- The native scene delegate, the patched `RNCarPlay.m`, AND the JS session (via
  RN `Settings`) all write breadcrumbs to the `StellaCarPlayDiagnostics`
  user-defaults key and to device Console logs with the `[carplay]` prefix —
  connect lifecycle, takeover retries, row selects, dictation phases, TTS
  starts. If a TestFlight build still fails only in a real car, collect iPhone
  logs in Console.app while launching Stella on CarPlay.
