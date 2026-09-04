# Mobile chat

Mobile chat lets connected and anonymous users open the canonical thread, compose and send messages, inspect artifacts, and respond to cloud-browser intervention cards when their plan permits them.

## Sub-features

- `mobile-thread-list` searches and selects conversations.
- `mobile-anonymous-chat` proves that account-free entry reaches the real composer and canonical anonymous conversation.
- `mobile-compose` drafts, attaches, and sends from the mobile composer.
- `mobile-timeline` renders user, assistant, tool, error, and working states. The
  working mark uses the bouncing ellipsis while thinking and animated character
  poses while a labelled tool is active.
- `mobile-replies` matches desktop: ordinary adjacent replies stay plain; returning work has one compact context label. That label and the lifecycle row open a focused chain above the composer, with Report inside focus.
- `mobile-artifacts` opens or shares files and completion output.
- `mobile-browser-intervention` presents pending cloud-browser actions.

## How to get to it (user POV)

- Enter Chat from the main mobile shell and choose a thread.
- Type in the composer and send.
- Tap an artifact, completion card, or browser intervention inside the timeline.

## Driving it with control-stella-ios

Preconditions:

- The main shell has either a connected or anonymous session and the iOS helper has a booted installed build.
- Sending or intervention behavior needs reachable cloud state.

- **Thread.** Capture `frame`, select a visible thread from fresh `screen` coordinates, and require its title/timeline.
- **Anonymous Chat.** Enter through **Continue without signing in**, open Chat, and capture both an accessibility snapshot and framebuffer. Require the composer and absence of `sign-in-prompt-button`. Submit one harmless prompt and accept a visible anonymous-limit or provider error as bounded transport proof.
- **Compose.** Tap the composer, type a unique harmless prompt, and capture the draft before sending.
- **Send.** Submit once and require the user turn, working state, or explicit error. When the working state is reachable, capture frames during thinking and labelled tool work; require the ellipsis to move during thinking and the character body or orbit to change during tool work. Bound the wait and collect logs on failure.
- **Working bubble handoff.** Send a short prompt. Require the 200 ms entrance delay, then a 240 ms background expansion into the answer with fixed-size text and no second indicator below it. Capture the transition and settled answer. Long replies and reduced motion appear directly; cancellation must leave no dots. Verify scrolling history or opening reply focus does not replay the transition.
- **Replies.** Delegate work, send an unrelated message, and wait for the result. Require a compact task description above the returning result, with no repeated quote or reply-count badge. Tap it and the original lifecycle row separately; require only the related messages above the still-visible composer. Open Report and require the saved cloud result. Close focus and require the original timeline position. Also verify a normal adjacent answer has no context label.
- **Artifact.** Open a visible artifact and require the preview or native share/open action appropriate to its type.
- **Intervention.** Only when a real card exists, open it and require its declared login/device-code state before taking an action.
- **Local cloud sign-in.** For a real login intervention on iOS, open the card and require the exact gateway-declared HTTPS origin in Stella's local WebView. Complete the fixture sign-in through visible simulator input, tap Done, require the checking/resume state, then have the resumed cloud browser revisit an authenticated page. This proves the cookie crossed through the encrypted import and survived a fresh Browser Run restore.
- **Fallback.** From the same local sign-in surface, choose **Use cloud browser** and require the existing private remote Live View. A same-origin boundary failure or rejected import should also show the fallback explanation without completing the interaction.

## Gotchas

- Mobile thread data is remote and may be empty or delayed.
- The on-screen keyboard moves controls. Recapture the Mac screen before every coordinate action.
- Provider output is not deterministic. Assert stable shell states and the submitted user turn.
- Do not synthesize cloud messages or interventions through backend calls merely to satisfy UI coverage.
- Local capture is cookie-only and iOS-native. It must not inject JavaScript, expose a page message bridge, or inspect DOM/form values. Other platforms use the remote Live View fallback until they have an equivalent privileged cookie API.
