---
name: chat-onboarding-alongside-legacy
description: As of 2026-09-01 the desktop first run is the chat-style onboarding in global/onboarding/chat; the legacy split-screen flow was deleted in commit db3a90761
metadata: 
  node_type: memory
  type: project
  originSessionId: c817b356-7453-4d69-bdf0-cb70c9900130
  modified: 2026-09-02T06:40:32.483Z
---

On 2026-09-01 the desktop first-run onboarding was rebuilt as a scripted conversation in `packages/desktop-ui/src/global/onboarding/chat/` (discovery first, then capabilities with side scenes, the one-conversation comparison, theme, extras, personalized finale). Commit b5bdebde0 added it alongside the old flow; commit db3a90761 removed the legacy split-screen flow, its phases, styles, tests, the fullscreen window-presentation IPC, and the welcome-HTML client path.

**Why:** The user iterated on the new flow with the Settings → General → Onboarding → Replay button, signed off, and asked for the old code to go.

**How to apply:** All onboarding work goes in the `chat/` module. `global/onboarding/` keeps only `demo/`, `chat/`, `post-onboarding-hints.ts`, `services/synthesis.ts`, `use-onboarding-appearance.ts`, and `use-onboarding-state.ts`. The backend `/api/synthesize/welcome-html` route still exists only as a dispatch-guard test fixture. Replay via Settings when verifying; the verifier harness seeds onboarding complete. See [[stella-product-model]] and [[no-flicker-launch-ux]].
