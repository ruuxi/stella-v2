# Stella verification map

This directory is the maintained source for verifying the user-facing behavior of the Stella desktop app. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch only through `node .cursor/skills/verify-stella/scripts/control-stella.mjs launch`.
- Isolated data dir and Electron user-data dir from that run. Never `~/.stella` and never the default `Stella Development` profile.
- Onboarding already marked complete. **New chat** is always a top-bar button in the conversation top bar.
- English UI.
- `control-stella doctor` reports `ok: true` with `[data-testid="conversation-topbar"]` present.
- Never drive an Electron or Vite process this helper did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise. Close dialogs with `Escape` before switching features.
- Prefer ARIA roles and accessible names over CSS. The few CSS exceptions are listed in the feature files (composer submit, dialog close).
- Treat every command as literal. Keep quoted names unchanged.
- Run all actions through `control-stella`.
- Restore the shell to one chat and no open dialog after a mutation. Keep proof artifacts.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the document title `Stella` and the control under test visible.
- Mutation proof includes a second read of the stored value (URL `c=` query, history row, `data/preferences.json`).
- Record the feature ID and entry point in the artifact name.
- Report an unreachable path with the attempted command and the unmet precondition. Sign-in, a connected LLM provider, and a paid plan are valid unreachable reasons. Do not call a skipped entry point verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-stella` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Chat](./chat.md) covers New chat, the composer, and sending a turn (or the visible failure when no provider is connected).
- [Conversation history](./conversation-history.md) covers opening history and distinguishing the current chat from the list.
- [Settings](./settings.md) covers the settings menu, dialog tabs, and dismiss.
- [Home](./home.md) covers the Home top-bar control and the workspace home surface.
- [Apps](./apps.md) covers the empty Apps library from the New tab launcher.
