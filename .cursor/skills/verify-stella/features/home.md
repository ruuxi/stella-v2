# Home

Home shows the workspace activity surface from the conversation top bar when a single chat tab is open. It is the overview of files, activity, and launchers, not a separate window.

## Sub-features

- `home-open` reveals the home / activity surface from the top-bar Home button.
- `home-close` returns to the chat column.

## How to get to it (user POV)

- Choose **Home** in the conversation top bar. The control is shown when there is a single conversation tab.

## Driving it with control-stella

Preconditions:

- Doctor is `ok`.
- Only one conversation tab is open. `shouldRenderConversationHomeLauncher` is true only then. If you already created extra chats, you may not see Home. Start from a fresh launch, or close extra tabs first.
- No dialog is open.

- **Open.** Choose Home. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --role button --name "Home"`. The region named `Activity` is not `aria-hidden`. Workspace section titles such as files or activity search (`Search activity and files`) are visible.
- **Close.** Choose Home again if it toggles, or click back into the chat composer. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs fill --placeholder "Do anything" --value ""` if the composer is still reachable, or click **Home** a second time if the surface stays up. The composer placeholder `Do anything` is visible and usable.
- **Proof.** Capture the open home surface. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs snapshot --path .cursor/skills/verify-stella/artifacts/home/open.aria.txt` and `node .cursor/skills/verify-stella/scripts/control-stella.mjs screenshot --path .cursor/skills/verify-stella/artifacts/home/open.png`. The artifacts show Stella plus the activity/home surface, not only the composer.

## Gotchas

- Home disappears from the top bar once two conversation tabs are open. Prove this feature before `chat-new`, or close the extra tab.
- A fresh profile may have no activity. Empty activity is still Home. Do not require seeded files.
- The right-hand workspace surface can stay mounted with `data-hidden="true"`. Assert `aria-hidden` / visibility, not merely that the node exists in the snapshot.
