# Home

Home is the full-body overlay shown for an empty or idle chat. It contains the greeting and main composer, not the former Activity, Files, and Search workspace panel.

## Sub-features

- `home-open` opens `.full-body-home-overlay` from the top-bar Home control.
- `home-compose` accepts a prompt in the Home composer.
- `home-exit` returns to chat after a send, entering a populated conversation, or switching conversations.

## How to get to it (user POV)

- Choose **Home** in the conversation top bar when the launcher is visible.
- Open a fresh empty conversation. Home may appear automatically.
- Send from Home or select a populated conversation to return to the chat timeline.

## Driving it with control-stella

Preconditions:

- The desktop verifier is healthy and no dialog is open.
- If Home is absent because the current conversation is populated, create a new conversation first.

- **Open.** Run `node .agents/skills/verify-stella/control-stella.mjs nav home`. Require `homeOpen: true` from `inspect state`.
- **Inspect.** Run `node .agents/skills/verify-stella/control-stella.mjs inspect components` and require the visible Home greeting/composer controls.
- **Proof.** Run `inspect aria --path .agents/skills/verify-stella/artifacts/home/open.aria.txt` and `inspect screenshot --path .agents/skills/verify-stella/artifacts/home/open.png`.
- **Exit.** Submit through the Home composer, or use `inspect components` and `drive click --role tab --name "Open <populated conversation title>"` to select an existing populated conversation. Require `homeOpen: false` after entering that non-empty conversation.

## Gotchas

- Home is not a toggle. Clicking **Home** while already open is not the close recipe.
- Empty and idle logic can reopen Home later. Assert the immediate transition and relevant conversation state.
- Do not look for the stale `Activity` region or `Search activity and files` copy.
- The top-bar launcher can be conditional on shell and tab state.
