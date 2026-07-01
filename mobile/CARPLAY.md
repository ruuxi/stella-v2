# Stella CarPlay — voice mode

A driving-safe, voice-first CarPlay experience for Stella. It is glance-free:
tap once, speak, and Stella records, transcribes, answers, and reads the answer
back aloud — the whole hands-free loop in the car.

## The two surfaces

Stella ships exactly two CarPlay surfaces, both reachable under the CarPlay
**audio** entitlement:

| Surface | CarPlay template | What it is |
| --- | --- | --- |
| **Voice home** | `CPListTemplate` root + `CPVoiceControlTemplate` overlay | The big tap-to-talk affordance. The single Stella-green row toggles record → send. While Stella listens and thinks, the system voice-control interaction is presented over it ("Listening…", "Stella is thinking…"). |
| **Replay card** | `CPNowPlayingTemplate` | A now-playing-style card for the **last** reply, with a one-tap green **Replay** control (road-noise insurance) and a **Talk** control to start the next turn hands-free. |

The flow: **tap → record → stop → transcribe → send → await reply →
auto-speak → replay card**.

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

- `src/carplay/carplay-session.ts` — imperative controller that owns the CarPlay
  templates and a small phase machine (`idle → listening → thinking →
  speaking`).
- `src/carplay/CarPlayBridge.tsx` — headless component (mounted in
  `app/_layout.tsx`, inside the Convex/auth providers) that drives the loop with
  the hooks above and binds tap callbacks to the session.

## Carrying Stella's design language into the templates

CarPlay only lets us use Apple's templates, so the brand lives in the levers we
control:

- **Stella green accent** — `assets/carplay/stella-voice-{mic,replay,listening}.png`
  are Stella-green glyphs (the palette's success/`ok` green) used in the list
  leading icon, the now-playing Replay/Talk buttons, and the voice-control
  state. Regenerate with `python3 assets/carplay/generate-icons.py`.
- **Naming + tone** — titles and labels match the phone app's voice
  ("Talk to Stella", "Stella is thinking…", "Stella is speaking", "Stella" as
  the template title), mirroring copy like "Ask Stella anything".
- **Now-playing pattern** — the replay surface uses Apple's real now-playing
  template (play/replay control), so it feels native to CarPlay.

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
   CarPlay connects before RN/JS finishes registering its listener.
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

4. **Drive the loop:** tap the row → it shows "Listening…" and the voice-control
   overlay appears → tap again to send → "Stella is thinking…" → the reply is
   spoken aloud and the **Replay card** appears. Tap **Replay** to hear it
   again, or **Talk** to start another turn.

   Make sure the app is signed in (or in guest mode) and AI consent + microphone
   permission have been granted once on the phone first — those prompts surface
   on the phone, not the car screen.

> Tip: if the CarPlay menu item is missing, ensure you're on a recent Xcode and
> that the app built and launched in the phone Simulator at least once.

## Notes / gotchas

- **Rich now-playing metadata** (title/artist/artwork on the replay card) would
  need `MPNowPlayingInfoCenter` populated natively when the TTS clip plays;
  today the card carries the Replay/Talk controls but not custom artwork.
- **react-native-carplay** (2.3.0) is a legacy-arch RCTBridgeModule; it loads on
  the New Architecture via the interop layer. Stella replays an already-connected
  session after registering its JS callback because the library's constructor can
  consume the native `checkForConnection()` replay before app code has registered
  its own connect handler.
- The native scene delegate writes the latest CarPlay lifecycle breadcrumbs to
  the app's `StellaCarPlayDiagnostics` user-defaults key and to device Console
  logs with the `[carplay]` prefix. If a TestFlight build still fails only in a
  real car, collect iPhone logs in Console.app while launching Stella on CarPlay.
