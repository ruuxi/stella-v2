# Conversation history

Conversation history is a cloud-authoritative popover for finding and reopening chats without immediately replacing the active conversation.

## Sub-features

- `history-open` reveals the history popover from the top bar.
- `history-list` shows loading, empty, error, or conversation rows from the cloud source.
- `history-select` switches to the selected conversation.
- `history-close` dismisses without changing the current conversation.

## How to get to it (user POV)

- Choose **Conversation history** in the conversation top bar.
- Choose a row to open that conversation.
- Press Escape or click away to dismiss without selecting.

## Driving it with control-stella

Preconditions:

- The desktop verifier is healthy and no Settings dialog is open.
- Account and network state determine whether rows are available.

- **Open.** Record `chat state`, then run `node .agents/skills/verify-stella/control-stella.mjs nav history`. Require `historyOpen: true`.
- **Classify.** Capture `inspect aria` and accept an explicit loading, empty, error, or populated state. Do not invent a row.
- **Select.** When a row exists, use `inspect components` to obtain its accessible handle, then `drive click`. Require `chat state` to report the selected conversation id.
- **Dismiss.** Run `node .agents/skills/verify-stella/control-stella.mjs drive press --key Escape`. Require the original conversation id to remain unchanged when no row was selected.

## Gotchas

- The active local conversation is not guaranteed to be present in cloud history immediately.
- A new row is not guaranteed to be titled `New chat` because title generation and synchronization are asynchronous.
- Opening can also be hover-driven. Use the named `nav history` click for deterministic verification.
- Empty history is valid only when the UI exposes an explicit empty state rather than silently rendering nothing.
