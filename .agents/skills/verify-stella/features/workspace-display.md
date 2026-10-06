# Workspace display

The workspace display is Stella's right-side panel (`aside` named Workspace) for files, browser views, apps, updates, media, and other payload-backed tabs alongside chat. Its header has the tab strip (`Sidebar` tablist; each tab has a `Close <title>` button), **New tab**, and **Close panel**; its foot has the execution target (`Run on <target>`) and **Models**. A new tab is the `Home` launcher with a `Search anything` box and **Files**, **Apps**, **Browser**, and **Updates**.

## Sub-features

- `display-open` opens a payload as a right-side tab.
- `display-tabs` selects and closes tabs.
- `display-topbar` exposes controls appropriate to the active tab.
- `display-collapse` hides or restores the display without losing its tab model.

## How to get to it (user POV)

- Choose **Open panel** in the top bar, or right-click in the chat column.
- Open a file, browser result, app, or artifact from chat, or a destination from **New tab**.
- Choose another tab in the panel's tab strip.
- Use the tab's close control or **Close panel**.

## Driving it with control-stella

Preconditions:

- A source feature must produce a real display payload. Files and Browser are the simplest entry points.
- The verifier is healthy with no modal dialog open.

- **Open source.** Run `nav files`, `nav browser`, or select a chat artifact, then use `inspect state` and `inspect components` to identify the display tab.
- **Select.** Run `drive click --role tab --name "<visible tab>"` and require `aria-selected=true` in `inspect aria`.
- **Top bar.** Capture `inspect components` and assert only controls applicable to the active payload.
- **Close.** Use the tab's `Close <title>` button. Require another tab to activate, or, when it was the last tab, the panel to close (`panelOpen: false`).
- **Collapse.** Choose **Close panel**, then **Open panel**. Require the selected tab and conversation id to remain unchanged.
- **Proof.** Capture the full shell so chat and the right-side content are visible together.

## Gotchas

- Display content can remain mounted while hidden. Assert visibility and selected-tab state, not DOM presence alone.
- Different payload kinds map to different viewers and top-bar actions.
- Closing a display tab should not close the conversation.
- Avoid coordinate clicks until `inspect components` proves a named handle is unavailable.
