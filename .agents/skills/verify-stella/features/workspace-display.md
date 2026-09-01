# Workspace display

The workspace display is Stella's right-side surface for files, browser views, apps, media, and other payload-backed tabs alongside chat.

## Sub-features

- `display-open` opens a payload as a right-side tab.
- `display-tabs` selects, reorders, and closes tabs.
- `display-topbar` exposes controls appropriate to the active tab.
- `display-collapse` hides or restores the display without losing its tab model.

## How to get to it (user POV)

- Open a file, browser result, app, or artifact from chat or a sidebar section.
- Choose another display tab in the display top bar.
- Use the active tab's close or visibility control.

## Driving it with control-stella

Preconditions:

- A source feature must produce a real display payload. Files and Browser are the simplest entry points.
- The verifier is healthy with no modal dialog open.

- **Open source.** Run `nav files`, `nav browser`, or select a chat artifact, then use `inspect state` and `inspect components` to identify the display tab.
- **Select.** Run `drive click --role tab --name "<visible tab>"` and require `aria-selected=true` in `inspect aria`.
- **Top bar.** Capture `inspect components` and assert only controls applicable to the active payload.
- **Close.** Use the named close control discovered for the active tab. Require another tab to activate or the display to hide cleanly.
- **Proof.** Capture the full shell so chat and the right-side content are visible together.

## Gotchas

- Display content can remain mounted while hidden. Assert visibility and selected-tab state, not DOM presence alone.
- Different payload kinds map to different viewers and top-bar actions.
- Closing a display tab should not close the conversation.
- Avoid coordinate clicks until `inspect components` proves a named handle is unavailable.
