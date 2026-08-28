# Settings

Settings is a dialog over the shell, not a route the top bar navigates to. A user opens it from the gear menu, switches tabs, and dismisses it. `/settings` still exists as a standalone route and should match the same tabs.

## Sub-features

- `settings-menu` opens the destinations menu from the gear button.
- `settings-open` opens the Settings dialog from that menu.
- `settings-tabs` selects General, Shortcuts, Backups, Account & Legal, and Audio.
- `settings-search` filters the General tab's search field.
- `settings-close` dismisses the dialog and returns to chat.

## How to get to it (user POV)

- Choose the **Settings** gear, then the **Settings** menu item.
- Open `/settings` in the same Electron window (secondary). The gear path is the one users hit.

## Driving it with control-stella

Preconditions:

- Doctor is `ok`.
- No dialog is already open.

- **Open menu.** Choose the gear. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --role button --name "Settings"`. A menu named `Settings destinations` appears with items `Settings`, `Theme`, `Stella on your phone`.
- **Open dialog.** Choose Settings in that menu. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --role menuitem --name "Settings"`. A dialog titled `Settings` appears. The tablist named `Settings` has `General` selected.
- **Tab Shortcuts.** Choose Shortcuts. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --role tab --name "Shortcuts"`. The tabpanel is labelled by Shortcuts. The heading `Shortcuts` is visible.
- **Tab remaining.** Choose `Backups`, then `Account & Legal`, then `Audio` the same way. Each selected tab's accessible name matches the tab, and General is no longer `aria-selected`.
- **Search.** Return to General, then type in Search settings. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --role tab --name "General"` and `node .cursor/skills/verify-stella/scripts/control-stella.mjs fill --placeholder "Search settings" --value "language"`. The results mention Language. Clear by emptying the field or dismissing search UI so tabs work again.
- **Close.** Press Escape. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs press --key Escape`. The dialog is gone. `[data-testid="conversation-topbar"]` is visible.
- **Proof.** Capture the open dialog on General before closing. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs snapshot --path .cursor/skills/verify-stella/artifacts/settings/open.aria.txt` and `node .cursor/skills/verify-stella/scripts/control-stella.mjs screenshot --path .cursor/skills/verify-stella/artifacts/settings/open.png`. The artifacts show the Settings tablist and the General tab selected.

## Gotchas

- The first click on **Settings** opens a menu, not the dialog. A second click on the **Settings** item is required. If the menu closed because the click matched the gear again, reopen it.
- `/settings` is a full-page Settings screen used in tests and deep links. Proving only that route skips the menu users actually click.
- The dialog close X has no accessible name. Use Escape.
- Account & Legal and Backups can mention sign-in. Signed-out copy is expected for an isolated profile. Do not treat a sign-in prompt as a harness failure.
- Settings search replaces the tab panel. Clear the query before asserting tabs again.
