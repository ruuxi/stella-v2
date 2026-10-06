# Home

Home is the full-body overlay over the chat column: a greeting, the main composer, and a "Right-click to open the workspace panel" hint. It is not a launcher and not the workspace panel's Home tab.

## Sub-features

- `home-open` shows `.full-body-home-overlay` automatically.
- `home-compose` accepts a prompt in the Home composer.
- `home-exit` returns to the chat timeline after a send.

## When Home shows

The rule is `shell/use-chat-home-surface.ts` and `features/chat/hooks/use-idle-home-visibility.ts` in `packages/desktop-ui/src`:

- The conversation has no messages.
- First view after launch, until the user interacts with the chat in this session, even when the conversation has messages.
- After an hour without activity, when nothing is streaming.
- Not while the conversation's first snapshot is still loading, and not after the user dismissed it (persisted per window as the last chat/home surface).

## How to get to it (user POV)

- Launch Stella on an empty conversation, or relaunch over a populated one.
- Send from Home to enter the timeline.

## Driving it with control-stella

Preconditions:

- The desktop verifier is healthy and no dialog is open.
- A fresh `session launch --replace` gives an empty conversation. There is no New chat or history control to create another.

- **Open.** After a fresh launch, run `node .agents/skills/verify-stella/control-stella.mjs nav home`. It checks the overlay and never creates a conversation; it fails with `APP_NOT_READY` when Home is not showing.
- **Inspect.** Run `node .agents/skills/verify-stella/control-stella.mjs inspect components` and require the Home composer (`Do anything`), dictation and voice buttons, and the right-click hint.
- **Proof.** Run `inspect aria --path .agents/skills/verify-stella/artifacts/home/open.aria.txt` and `inspect screenshot --path .agents/skills/verify-stella/artifacts/home/open.png`.
- **Exit.** Run `node .agents/skills/verify-stella/control-stella.mjs chat send --text "<prompt>"`. Require `homeOpen: false` from `inspect state` and the sent message in the timeline.

## Gotchas

- There is no top-bar Home launcher, conversation history, or New chat control.
- Idle logic can reopen Home later. Assert the immediate transition and relevant conversation state.
- The workspace panel's `Home` tab (Files, Apps, Browser, Updates launcher) is a separate surface from the chat Home overlay.
