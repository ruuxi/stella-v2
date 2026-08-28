# Apps

Apps is the local user-app library. A new profile has none. The user opens the library from the New tab launcher and sees the empty state, including a control that asks Stella to create an app.

## Sub-features

- `apps-open` opens the Apps section from New tab.
- `apps-empty` shows the empty library copy.
- `apps-ask` offers the empty-state action that returns to chat with a create-app prompt.

## How to get to it (user POV)

- Choose **New tab** in the sidebar, then **Apps**.
- Choose **Apps** if an Apps sidebar tab is already open.

## Driving it with control-stella

Preconditions:

- Doctor is `ok`.
- Isolated data dir has no user apps (true for a fresh launch).
- Display panel / sidebar is visible. The default 1400x940 window is wide enough.

- **Launcher.** Choose New tab. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --role button --name "New tab"`. Buttons named `Quick chat`, `Files`, `Apps`, and `Browser` appear.
- **Open Apps.** Choose Apps. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --name "Apps"`. A sidebar tab labelled `Apps` is selected. The empty title `No apps yet` or `Nothing here yet.` is visible, plus body copy that apps show up after Stella builds one.
- **Empty action.** If a button named `Create an app` or `Ask Stella to create an app` is visible, choose it. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --name "Ask Stella to create an app"` or `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --name "Create an app"`. The composer receives a create-app prompt (product copy: `Tell me what stella apps can you make for me?`) or the library remains on the empty state. Either is acceptable. Creating a real app is not part of this feature. That path runs the agent and needs a provider.
- **Proof.** Capture the empty library. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs snapshot --path .cursor/skills/verify-stella/artifacts/apps/empty.aria.txt` and `node .cursor/skills/verify-stella/scripts/control-stella.mjs screenshot --path .cursor/skills/verify-stella/artifacts/apps/empty.png`. The artifacts show an Apps tab or empty-state heading.

## Gotchas

- Clicking **Apps** from the launcher is different from clicking a user-app card. With no apps, there are no cards.
- `unsupportedTitle` copy (`Apps are available on desktop.`) is a renderer-without-Electron failure. If you see it in this launch, Electron IPC for user apps is missing and doctor should have failed first.
- Do not run **Create an app** through to a generated project. That is a long agent turn. Stop at the empty state or at the composer prompt.
- `/apps` as a standalone route exists. The launcher is the user path. If you only load `/apps`, still assert the same empty copy.
