# Chat

Chat is the default shell. A user starts or continues a conversation, types in the composer, and sends with Enter. Without a connected model provider the send can fail in the timeline. That failure is still the user path.

## Sub-features

- `chat-ready` shows the conversation top bar and an enabled composer after launch.
- `chat-new` creates another conversation from **New chat**.
- `chat-type` accepts text in the composer placeholder `Do anything`.
- `chat-send` submits with Enter. A model reply is optional. A user bubble or a visible provider error is enough.

## How to get to it (user POV)

- Open Stella. `/` redirects to `/chat`, then Electron fills `?c=<conversationId>`.
- Choose **New chat** in the conversation top bar (direct mode).
- Type in the composer and press Enter.

## Driving it with control-stella

Preconditions:

- Doctor is `ok`.
- Working mode is direct. `[data-testid="conversation-topbar"][data-working-mode="direct"]` is present.
- No dialog is open.

- **Ready.** Confirm the shell. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs wait --selector "[data-testid=conversation-topbar]"`. The composer placeholder `Do anything` is visible and the textarea is not disabled.
- **URL conversation.** Read the location. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs eval --js "location.pathname + location.search"`. The string starts with `/chat?c=` and the id is non-empty.
- **Type.** Focus the composer. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs fill --placeholder "Do anything" --value "hello from verify-stella"`. The textarea value is `hello from verify-stella`. The submit button `.composer-submit` is no longer disabled.
- **Send.** Press Enter. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs press --key Enter`. The composer clears or stays busy. The timeline shows the user text `hello from verify-stella`, or a visible error that a provider is missing. Do not wait indefinitely for a model token.
- **New chat.** Choose **New chat**. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs click --role button --name "New chat"`. `location.search` gets a different `c=` value. The composer is empty again.
- **Proof.** Capture the typed or sent state. Run `node .cursor/skills/verify-stella/scripts/control-stella.mjs snapshot --path .cursor/skills/verify-stella/artifacts/chat/composer.aria.txt` and `node .cursor/skills/verify-stella/scripts/control-stella.mjs screenshot --path .cursor/skills/verify-stella/artifacts/chat/composer.png`. The artifacts show Stella, the top bar, and either the draft text, the user message, or the provider error.

## Gotchas

- New chat is missing in orchestrated mode. If `data-working-mode` is `orchestrated`, the launch seed failed. Stop and relaunch. Do not treat Conversation history's New chat as a substitute unless you are on the history feature file.
- The composer textarea is `disabled` when `conversationId` is null. That happens in a plain browser on the Vite URL. It must not happen in this Electron launch.
- Enter submits. Shift+Enter is a newline. `control-stella press --key Enter` sends a real key event, which is the user path.
- The submit glyph has no accessible name. Do not click it by role/name. Use Enter.
- A successful send without API keys is not required. Hanging on a spinner until timeout is a product or network problem, not a reason to skip `chat-type`.
