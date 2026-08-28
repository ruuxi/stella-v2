# Scoping: phone-call escalation for blocked agent tasks

Status: scoping only — nothing here is implemented yet.

## Goal

When an agent task is blocked on user input (OAuth grant, credential, a decision) and the
user doesn't respond through the normal channels, escalate to a native incoming-call
experience on the user's phone (lock-screen call UI). Answering the call drops the user
into the existing realtime voice session, opened with context about why the call is
happening ("Task X is blocked on Y"). If the call isn't answered, the task parks as
blocked and resumes when the user eventually responds.

No PSTN / real phone numbers involved — this is CallKit (iOS) and a CallStyle
full-screen-intent notification (Android) fronting our own realtime voice.

## Recommendation: escalation policy, not a model tool

Two candidate trigger designs were considered:

1. A `CallUser` tool the agent invokes.
2. An automatic escalation ladder attached to the existing "waiting on user" timeouts.

**Option 2 is the right one.** The codebase already funnels every blocking user request
through one chokepoint on desktop: `packages/desktop/electron/services/pending-request-store.ts`
holds the pending promise + `setTimeout` for both
`credential-service.js` (`RequestCredential`, 5 min timeout) and
`connector-connect-service.js` (`connector_status` OAuth cards, 9.5 min timeout). Today
those timeouts just reject/give up. Converting that single timeout into a staged
escalate-then-expire ladder gives *every* current and future blocker escalation for free,
without relying on the model remembering to call a tool.

The tool surface still grows, but on the "ask" side, not the "call" side: decision
blockers currently have **no** representation in the desktop runtime (`AskUserQuestion`
exists only as an unused zod schema in `packages/backend/convex/agent/tool_schemas.ts:254`).
Adding an `AskUserQuestion` tool to `packages/runtime/kernel/tools/defs/` that routes
through the same pending-request store means decisions get the same ladder as credentials
and OAuth.

## The escalation ladder

All timers live in Electron main (agents run in the desktop runtime worker — local-first;
Convex is only the relay). Stages, each configurable:

| Stage | When (default) | Action |
|---|---|---|
| 0 | request created | In-app card (existing) + desktop `showStellaNotification` |
| 1 | +60–120 s | Mobile push (extend `pushDataValidator` in `packages/backend/convex/mobile_push.ts` with a `needs_input` kind; deep-link to the blocker) |
| 2 | +2–5 min | **The call.** If `device_presence` shows the desktop active → desktop just starts speaking via `uiStateService.activateVoiceRtc()`. Otherwise → VoIP/high-priority push → native incoming-call UI on the phone |
| — | ring ~30–45 s unanswered | Mark task `blocked`, park it, stop ringing. Resume later via the `[wake: …]` synthetic-turn pattern (`packages/runtime/kernel/runner/background-exit-wake.js`) when the user responds through any channel |

A 30-second jump straight to a call is too aggressive as a default — the ladder makes the
call the *last* resort and each threshold a user setting (including "never call me").

## What the call actually is

**Answered call → auto-join realtime voice.** The mobile realtime client
(`packages/mobile/src/lib/realtime-voice.ts`, `MobileRealtimeVoiceSession`) is already a
headless imperative class — this is the easy part. The server route `POST
/api/voice/session` (`packages/backend/convex/http_routes/voice.ts`) already accepts
arbitrary `instructions`, and the client can inject an opening
`conversation.item.create` + `response.create` so the model speaks first: "Hi — I'm
calling because the Notion task is blocked waiting on your Google authorization…". Use
the realtime path, not TTS/STT — it's the better experience and needs less new plumbing.

## Work map

### A. Blocked-state modeling (prerequisite, largest unknown)

There is no `blocked` / `awaiting_input` state anywhere. Task status is
`pending | running | completed | error | canceled`
(`packages/contracts/agent-runtime.ts`, `event-transforms.ts`).

- Add a `blocked` lifecycle state + a side record `{threadId, kind:
  oauth|credential|decision, question, requestId, askedAt, escalationStage}` in
  `packages/runtime/kernel/storage/database-init.ts` + `session-store.js`.
- Surface it in the event stream (`AGENT_STREAM_EVENT_TYPES`) and mirror to Convex so the
  phone can render "what Stella is waiting on" and the call/push can carry it.
- Related hole to fix — OAuth blockers from background agents. Connector actions run
  through the agent-agnostic `connect` client in `node_repl`
  (`packages/runtime/kernel/connectors/connect-service.ts`), so General *can* call
  connectors; what it can't do is raise the chat OAuth connect card, which today only
  `connector_status` (orchestrator-only) triggers. When General hits an unconnected
  service, the composio-brokered path throws with no UI at all, and the oauth-catalog
  path pops the plainer credential dialog via `withAuthRetry`
  (`connect-service.ts:188-232`).

  **Decision: raise the connect card from the infrastructure, not the model.** The card
  is just a host RPC (`host.connectorConnect.request`, wired agent-agnostically in
  `packages/runtime/worker/server.ts:985` → `connector-connect-service.js`), and its
  payload already carries `conversationId`. So:
  - `withAuthRetry` (oauth-catalog): on `ConnectorAuthError` for an OAuth-able
    connector, call `requestConnectorConnection` (the connect card) instead of the
    credential dialog; keep the credential dialog for plain API-key `tokenKey` secrets.
  - Composio path (`callBackendNativeIntegration`): detect the broker's "not connected"
    case (needs a structured error code from the broker, not message matching) and
    raise the same card, then retry once on `{ok: true}`.

  Because the card is raised host-side with the parent `conversationId`, it appears in
  the chat immediately — no dependency on the orchestrator taking a turn — and it flows
  through `connector-connect-service.js` → `pending-request-store.ts`, so it inherits
  the escalation ladder for free. Guardrails: respect `connect-preferences.ts` declines,
  dedupe to one card per connector per task. The repl cell blocks at most 60s (see the
  cutover rule in §B); a later auth grant arrives via wake, not an in-cell retry.

### B. Escalation engine (desktop Electron main)

- **Blocking cap: 60 seconds, then detach — never give up.** The current timeouts
  (5 min credential, 9.5 min connector card) lock the agent/orchestrator for their whole
  duration, and a hard 60s expiry would kill the request before the ladder's later
  stages fire. So the 60s mark is a *cutover*, not an expiry: the tool call returns
  `{status: "pending", requestId}` and the agent is free to continue or park as
  `blocked`, while the request stays alive in the pending-request store, the card/dialog
  stays up, and the ladder keeps running. When the user resolves it — card, push, or
  call — the result is delivered via the `[wake: …]` pattern and the agent resumes.
  Consequence for the in-repl `connect.call()` path: the transparent
  retry-inside-the-cell only works for responses within 60s; a late auth resolves via
  wake ("X is now connected — retry the action") instead.
- `pending-request-store.ts`: replace the single expiry `setTimeout` with the 60s
  detach + staged escalation timers + a final expiry (hours, not minutes).
- New `escalation-service.js` next to the other services: runs the ladder, checks
  `device_presence`, chooses desktop-voice vs. phone-call, records outcome, cancels
  remaining stages the moment the user responds anywhere.
- Desktop-voice branch: `uiStateService.activateVoiceRtc(conversationId)` (precedent:
  `pet-voice-control.js`), with blocker context merged into
  `buildVoiceSessionInstructions()`
  (`packages/desktop-ui/src/features/voice/services/realtime/voice-session.ts`).

### C. Push delivery (the biggest infra gap)

Expo Push cannot deliver an iOS VoIP (PushKit) push, and Android call UI needs a
high-priority FCM data message. Net-new alongside `mobile_push.ts`:

- Direct APNs sender (`.p8` token auth, `apns-push-type: voip`) as a Convex
  internalAction; store VoIP push tokens per device next to `mobile_push_tokens`
  (`packages/backend/convex/schema/devices.ts`).
- Direct FCM v1 sender for high-priority data messages (Android).
- Stage-1 (non-call) push stays on Expo: widen the closed `pushDataValidator` union with
  `needs_input`, mirror in `packages/contracts/convex-api.ts`, and add copy in
  `activityNotificationCopy`.

### D. Native call UI (mobile)

The mobile app is Expo CNG (no checked-in `ios/`/`android/`; `.gitignore` excludes them),
so everything ships as a config plugin or local Expo Module. Two in-repo templates:
`plugins/withStellaCarPlay.js` (raw Obj-C injection via config plugin) and
`modules/stella-storefront/` (local Expo Module with Swift). Build a purpose-made local
module — `react-native-callkeep` doesn't cover PushKit registration and fights CNG.

- **iOS**: PushKit registration + CallKit `CXProvider` (report incoming call immediately
  on VoIP push — Apple requires it since iOS 13), answer/decline → JS events. Audio must
  route through CallKit's `didActivateAudioSession`, slotted into
  `packages/mobile/src/lib/audio-session-coordinator.ts`. Entitlements/Info.plist via
  config plugin: `UIBackgroundModes: [voip, audio]`, VoIP entitlement.
- **Android**: FCM data message → post a `Notification.CallStyle` notification on a new
  `MAX`-importance channel with a full-screen intent (ringtone, answer/decline on lock
  screen). This gets the full call experience without a `ConnectionService`;
  ConnectionService/`MANAGE_OWN_CALLS` is an optional later upgrade. Manifest additions
  (`POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT`, `FOREGROUND_SERVICE_MICROPHONE`) via a
  new `withAndroidManifest` plugin.

### E. Answer → voice session (mobile JS)

- Hoist session ownership out of `RealtimeVoiceOverlay.tsx` (today it's constructed in a
  `useEffect` gated on `visible`, and an `AppState: "background"` listener tears the
  session down — both need a call-mode path).
- On answer: cold-start-safe auth (`expo-secure-store` token via `auth-token.ts`) →
  `POST /api/voice/session` with escalation `instructions` → join, inject opening line.
- Prefer `execution: "phone"` for escalation calls; the `execution: "computer"` bridged
  mode requires the desktop reachable at answer time, which is exactly the situation
  where the desktop may be idle/asleep.
- Decline / ring-timeout → report back over the bridge (or Convex) → engine parks the
  task as blocked.

### F. `AskUserQuestion` tool (decision blockers)

New `packages/runtime/kernel/tools/defs/ask-user-question.ts` modeled on
`request-credential.ts`: blocking host round-trip through `pending-request-store.ts`, so
decisions inherit the ladder automatically. Desktop card UI + mobile rendering of the
question (the `credential:request` mobile broadcast already exists at the transport level
but has no mobile UI consumer — build both together).

## Suggested phasing

1. **Phase 1 — blocked state + ladder minus the call**: A, B, stage-1 push (Expo,
   `needs_input` kind), `AskUserQuestion`, wake-on-response. Immediately useful alone.
2. **Phase 2 — desktop speaks**: stage-2 desktop branch via `activateVoiceRtc` with
   blocker instructions. No native mobile work; validates the voice-context shape.
3. **Phase 3 — the real call**: C + D + E (VoIP/FCM senders, native module, call-mode
   voice session). The heavy lift: new native module, EAS credential setup (APNs VoIP
   cert/key, FCM service account), App Store review considerations for VoIP.

## Open questions

- Default thresholds and quiet hours; "never call me" must exist.
- Whether stage 2 should ring the phone even when the desktop is active (user may be away
  from the desk with the app open).
- iOS review: CallKit for non-telephony "agent calls" is allowed (apps like Slack/Discord
  huddles do it) but the VoIP-push-must-report-call rule means we must only send the VoIP
  push at the moment we intend to ring.
- Whether the cloud fallback runner (`packages/backend/convex/automation/runner.ts`)
  ever needs its own escalation path (desktop offline entirely) — out of scope for now.
