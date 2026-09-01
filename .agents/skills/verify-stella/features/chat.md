# Chat

Chat is Stella's primary desktop surface. A user opens or creates a conversation, writes in the real composer, and sends a turn through the selected execution target.

## Sub-features

- `chat-ready` resolves an active conversation and enabled composer.
- `chat-new` creates and selects a distinct conversation.
- `chat-draft` accepts text without mutating the timeline.
- `chat-send` shows the user turn or a visible provider/runtime failure.

## How to get to it (user POV)

- Launch Stella. Electron creates or restores the active conversation and exposes its id on the conversation top bar; the full-window URL may remain `index.html?window=full`.
- Choose **New chat** in the conversation top bar.
- Enter text in **Do anything** and press Enter.

## Driving it with control-stella

Preconditions:

- `node .agents/skills/verify-stella/control-stella.mjs session doctor` reports healthy.
- No dialog or sidebar popover covers the composer.

- **Ready.** Run `node .agents/skills/verify-stella/control-stella.mjs chat ready`. Require `ready: true`, a non-empty conversation id, and an enabled visible composer.
- **Inspect.** Run `node .agents/skills/verify-stella/control-stella.mjs chat state`. Record the conversation id and route without exposing message contents.
- **Draft.** Run `node .agents/skills/verify-stella/control-stella.mjs drive fill --placeholder "Do anything" --value "hello from verify-stella"`, then capture `inspect aria` and `inspect screenshot` artifacts.
- **Send.** Run `node .agents/skills/verify-stella/control-stella.mjs chat send --text "hello from verify-stella"`. Require the user message or a bounded visible provider/runtime error. Do not wait indefinitely for model output.
- **New conversation.** Run `node .agents/skills/verify-stella/control-stella.mjs chat new`. Require a conversation id different from the recorded id.

## Gotchas

- A plain Vite browser tab lacks the Electron bridge and can paint while the composer remains disabled.
- Enter sends and Shift+Enter inserts a newline. `drive press` accepts chords such as `Shift+Enter` and `Meta+KeyN`.
- A live assistant reply depends on configured providers. The user turn or explicit error is sufficient for the submission path.
- Do not assert a conversation title immediately. Cloud history and title generation can update asynchronously.
