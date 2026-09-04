# Desktop companion

The companion is the floating Stella mark that sits on top of every window. It is two transparent, always-on-top Electron windows served by one entry (`companion.html`): the small **mark** window (`?window=companion`, hover / click / drag) and the fixed-size **panel** window behind it (`?window=companion-panel`, arc / composer / bubbles) that is click-through until the mark is hovered or the panel has content. Both are thin views over the full shell's chat runtime: the shell publishes the latest exchange and running-agent count, and executes the sends the companion relays back.

## Sub-features

- `companion-toggle` shows or hides it from Settings › General, persisted across launches.
- `companion-hover` reveals the arc of buttons (read aloud, dictate, voice) around the mark.
- `companion-compose` opens the prompt pill on click and sends into the active conversation.
- `companion-bubbles` mirrors the latest user message and reply as bubbles that fade after a dwell.
- `companion-drag` moves the mark anywhere on screen; the anchor is persisted.
- `companion-dictation` routes the global dictation shortcut here whenever the full shell is not focused: press to start, press again to transcribe and send.

## How to get to it (user POV)

- Settings › General › **Desktop companion** switch.
- Hover the mark for the arc; click it for the composer; drag it to move; right-click for Open Stella / Hide / Quit.
- Press the dictation shortcut from any other app to summon it and start recording.

## Driving it with control-stella

The control CLI only targets the full shell page. The companion is two CDP page targets on the run's `cdpPort` (URLs ending in `window=companion` and `window=companion-panel`); drive them with a raw CDP client (`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`).

- **Enable.** `settings open`, then click the `button[role=switch]` inside the settings card whose text contains "Desktop companion". Require both companion targets to appear in `/json` on the CDP port.
- **Geometry.** The mark window is 128×128 DIP and the panel 400×560 DIP; neither ever resizes. The panel shares the mark window's edges that face the nearer screen borders. On Hyprland, `hyprctl clients -j` lists both with title `Stella Overlay`; sizes there are logical (divide DIP by the monitor scale).
- **Hover.** Move the pointer onto the mark window (`64,72`). Require `.companion-mark-root[data-hovered]` in the mark target and `.companion-arc[data-visible]` in the panel target.
- **Compose.** Click the mark (mark target); require `.companion-composer` with the textarea focused in the panel target (its only button is send, or stop while streaming), `Input.insertText` there, then Enter. Require the prompt in the full shell's transcript (`inspect eval` on `document.body.innerText`) and a `.companion-bubble[data-role="user"]` followed by an assistant bubble.
- **Drag.** Press on the mark, move with `buttons: 1`, release (mark target). Require both window positions in `hyprctl clients` to change and `companionAnchor` in the run's `data/preferences.json` to update.
- **Disable.** Toggle the switch off; require both windows to leave `hyprctl clients` (Linux with no main window destroys them, otherwise they hide) and `companionEnabled: false` in `preferences.json`.

## Gotchas

- Anonymous runs cannot record: the dictation path shows the "Sign in to use dictation" notice. Use `--account pro` to exercise transcription.
- The window collapses the composer on OS blur only after it actually received focus; on a workspace the user is not viewing (Hyprland), focus may never be granted, which is expected.
- Synthetic CDP mouse events carry inconsistent `screenX/Y`; drag assertions should use small moves and check direction, not exact distance.
- Hover ends on a real `mouseout` from the mark window; dispatching a synthetic `mouseleave` does not reach React. Use `Input.dispatchMouseEvent` moves that exit the window, or accept that hover stays on in a scripted run.
- The mark is excluded from Stella's own screen captures (content protection), so `inspect screenshot` of the full shell never shows it; use `grim` on the visible workspace or the companion page's own `Page.captureScreenshot`.
