# Quick chat

Quick chat is an isolated sidebar conversation for lightweight work that does not reuse the main conversation's runtime state.

## Sub-features

- `quick-chat-open` launches from New tab.
- `quick-chat-compose` sends through the sidebar composer.
- `quick-chat-isolation` keeps its runtime and messages separate from main chat.
- `quick-chat-close` dismisses the sidebar surface.

## How to get to it (user POV)

- Choose **New tab**, then **Quick chat**.
- Type in its sidebar composer and send.
- Close the sidebar tab or return to another shell surface.

## Driving it with control-stella

Preconditions:

- The desktop verifier is healthy and New tab is available.
- Provider-dependent response assertions require a configured model.

- **Open.** Run `node .agents/skills/verify-stella/control-stella.mjs nav quick-chat`.
- **Inspect.** Run `inspect components` and identify the Quick chat heading, composer, add control, and send/stop state.
- **Send.** Fill the Quick chat composer by its current placeholder, press Enter, and require the sidebar user turn or visible provider error.
- **Isolation.** Record main `chat state` before and after. Require the main conversation id to remain unchanged.
- **Close.** Use the visible tab close control and require Quick chat controls to disappear.

## Gotchas

- Do not use the main `chat send` journey for this isolated composer.
- Global model controls can be intentionally hidden while Quick chat is active.
- The sidebar may have distinct add, stop, and placeholder labels from main chat.
- A provider failure does not invalidate the navigation and isolation proof.
