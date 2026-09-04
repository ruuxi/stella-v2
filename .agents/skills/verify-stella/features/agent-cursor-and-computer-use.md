# Agent cursor and computer use

The agent cursor makes browser and native computer-use actions visible before Stella changes the target UI. It is passive presentation: the existing browser or OS action remains the input source.

## Sub-features

- `in-app-agent-cursor` renders inside the in-app browser page.
- `external-agent-cursor` renders in the top document of an extension-controlled Chromium tab.
- `native-agent-cursor` renders in a click-through overlay attached to the macOS or Windows target window.
- `cursor-arrival-gate` delays the real click until the cursor reaches the resolved action point.
- `cursor-cleanup` hides browser cursors when their owner session ends and native cursors after inactivity.

## Expected behavior

- The cursor uses the 23 by 24 pixel black pointer with white dotted edge and blue glow.
- Short moves scoot; longer moves follow a bounded curved path.
- Arrival produces one brief wobble, not a perpetual loop.
- Clicking has no synthetic ring, badge, or pulse. The target control's response is the click feedback.
- The overlay never receives pointer input and must not raise or focus the target window.

## Live verification

- **In-app browser.** Launch the isolated desktop app, open Browser, and navigate to a safe page containing two separated buttons. Record the compositor while a real agent clicks both buttons. Require each visible cursor arrival to precede the corresponding page-state change.
- **External Chromium.** Package or load the real Stella Browser extension, run the same two-button journey through the external backend, and capture the Chromium tab. Also exercise raw move/down/up and a drag if those actions changed.
- **macOS computer use.** On a graphical macOS session with Accessibility permission, snapshot a safe app such as Calculator or TextEdit, then execute two real element clicks through `stella-computer`. Require the software cursor to stay over the target app, move between resolved AX points, and arrive before each action.
- **Windows computer use.** On a Windows host, drive Notepad or Calculator through the real helper in both background and foreground dispatch modes. Require the passive layered window to remain owned by the target app, arrive before click/drag input, and leave the physical pointer and focus semantics unchanged for background dispatch.
- **Timing evidence.** Preserve a frame sequence containing start, in-flight, arrival, and changed target state. A typecheck, successful command receipt, or mocked controller is not visual proof.

## Gotchas

- The in-app browser is a native `WebContentsView`; the React renderer cannot paint above it.
- Browser cursor failure must fail open so protected pages do not block the real action indefinitely.
- macOS helpers launched from a new path may lack Accessibility permission even when the developer's installed Stella helper is trusted.
- Linux has browser control but no native desktop computer-use backend.
- The Windows overlay is excluded from OS capture to keep it out of Stella's own screenshots; verify its visible composition with an external camera or a capture path that intentionally disables that exclusion in a disposable build.
