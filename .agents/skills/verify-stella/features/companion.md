# Desktop companion

The companion is the floating Stella mark that sits on top of every window. It is its own transparent, always-on-top Electron window (`companion.html`), a thin view over the full shell's chat runtime: the shell publishes the latest exchange and running-agent count, and executes the sends the companion relays back.

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

The control CLI only targets the full shell page. The companion is a separate CDP page target (`companion.html`) on the run's `cdpPort`; drive it with a raw CDP client (`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`).

- **Enable.** `settings open`, then click the `button[role=switch]` inside the settings card whose text contains "Desktop companion". Require a `companion.html` target to appear in `/json` on the CDP port.
- **Geometry.** The window is 128×128 DIP while idle (mark only) and grows to 400×560 DIP on hover / composer / bubbles, keeping the mark's screen position. On Hyprland, `hyprctl clients -j` lists it with title `Stella Overlay`; sizes there are logical (divide DIP by the monitor scale).
- **Hover.** Move the pointer onto the mark (compact box: `64,72`). Require `.companion-root[data-mode="full"]` and `.companion-arc[data-visible]`. With a synthetic pointer, move to the mark's new in-window position right after the resize (grace is 340 ms) — a real cursor stays on it automatically.
- **Compose.** Click the mark, require `.companion-composer` with the textarea focused, `Input.insertText`, then Enter. Require the prompt in the full shell's transcript (`inspect eval` on `document.body.innerText`) and a `.companion-bubble[data-role="user"]` followed by an assistant bubble.
- **Drag.** Press on the mark, move with `buttons: 1`, release. Require the window position in `hyprctl clients` to change and `companionAnchor` in the run's `data/preferences.json` to update.
- **Disable.** Toggle the switch off; require the `companion.html` target to disappear (Linux with no main window destroys it, otherwise it hides) and `companionEnabled: false` in `preferences.json`.

## Gotchas

- Anonymous runs cannot record: the dictation path shows the "Sign in to use dictation" notice. Use `--account pro` to exercise transcription.
- The window collapses the composer on OS blur only after it actually received focus; on a workspace the user is not viewing (Hyprland), focus may never be granted, which is expected.
- Synthetic CDP mouse events carry inconsistent `screenX/Y`; drag assertions should start from the compact layout.
- The mark is excluded from Stella's own screen captures (content protection), so `inspect screenshot` of the full shell never shows it; use `grim` on the visible workspace or the companion page's own `Page.captureScreenshot`.
