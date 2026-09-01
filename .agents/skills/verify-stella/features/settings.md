# Settings

Settings is a dialog reached from the signed-out gear or signed-in account menu. It exposes a searchable catalog of tabs and links to adjacent Theme, phone, connector, feedback, account, and billing surfaces.

## Sub-features

- `settings-entry` opens from either top-bar identity state.
- `settings-tabs` covers the current platform-visible tab catalog.
- `settings-search` searches across tabs and jumps from a result to its owning tab.
- `settings-close` returns to the underlying shell.

## How to get to it (user POV)

- Signed out, choose **Settings**, then the **Settings** menu item.
- Signed in, choose the account control, then **Settings**.
- Use adjacent menu destinations such as **Theme** and **Stella on your phone** without treating them as Settings tabs.

## Driving it with control-stella

Preconditions:

- The verifier is healthy and no other modal dialog is open.
- English UI is active so named tabs match the feature map.

- **Open.** Run `node .agents/skills/verify-stella/control-stella.mjs settings open`. Require `settingsOpen: true` and a selected tab.
- **Catalog.** Run `inspect components` and compare visible tabs with `SETTINGS_TABS` after platform filtering. Do not hard-code a four-tab list.
- **Select.** Run `node .agents/skills/verify-stella/control-stella.mjs settings tab --name "Shortcuts"` for a visible tab and require it in `selectedTabs`.
- **Search.** Run `node .agents/skills/verify-stella/control-stella.mjs settings search --query language`. Require a result that identifies its owning section. Click that result when testing tab jump.
- **Close.** Run `node .agents/skills/verify-stella/control-stella.mjs settings close`. Require `settingsOpen: false` and the shell still healthy.

## Gotchas

- The first Settings click opens a destinations menu. The high-level command performs both clicks.
- Signed-in and signed-out entry controls differ.
- Search replaces the tab panel. Clear search before checking tab contents or closing via Escape.
- Tab availability is platform-dependent. Read `packages/desktop-ui/src/global/settings/settings-tabs.ts` before reporting drift.
- Theme, phone pairing, Connectors, and feedback are adjacent destinations, not all tabs inside the dialog.
