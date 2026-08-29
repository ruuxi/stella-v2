# Conversation history

Conversation history lets a user reopen the list of past chats from the top bar without leaving the current conversation until they choose a row.

## Sub-features

- `history-open` opens the history popover from the top-bar control.
- `history-lists-current` includes the active conversation in the list.
- `history-close` dismisses the popover without changing `?c=`.

## How to get to it (user POV)

- Choose the **Conversation history** button in the conversation top bar.

## Driving it with control-stella

Preconditions:

- Doctor is `ok`.
- At least one conversation exists (true after launch).
- No settings dialog is open.

- **Open.** Choose Conversation history. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --role button --name "Conversation history"`. A popover named `Conversation history` appears.
- **Current chat.** Wait for the list. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs wait --name "Conversation history"`. The popover contains a row for the current chat. A brand-new chat is titled `New chat`.
- **Close.** Press Escape. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs press --key Escape`. The popover is gone. `location.search` is unchanged.
- **Proof.** Capture the open popover before closing. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs snapshot --path .cursor/skills/verify-stella/artifacts/history/open.aria.txt` and `node .cursor/skills/verify-stella/scripts/control-stella.mjs screenshot --path .cursor/skills/verify-stella/artifacts/history/open.png`. The artifacts show the history popover and a `New chat` row.

## Gotchas

- The history trigger also opens on hover. Drive it with a click so the state is deterministic.
- New chat lives in the top bar, not in this popover. Drive `chat-new` from the top-bar button instead of looking for a row here.
- Closing by clicking the history button again also works. Prefer Escape so the pointer does not depend on toggle state.
