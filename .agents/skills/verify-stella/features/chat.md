# Chat

Chat is Stella's primary desktop surface. A user opens or creates a conversation, writes in the real composer, and sends a turn through the selected execution target.

## Sub-features

- `chat-ready` resolves an active conversation and enabled composer.
- `chat-new` creates and selects a distinct conversation.
- `chat-draft` accepts text without mutating the timeline.
- `chat-send` shows the user turn or a visible provider/runtime failure.
- `chat-dictation` records with a waveform pill, then transcribes the whole
  recording when stopped (managed `/api/dictation/transcribe`, or the user's
  own OpenRouter key through Electron main). A Stella without managed
  dictation and no saved OpenRouter key opens "Turn on dictation" instead.

## How to get to it (user POV)

- Launch Stella. Electron creates or restores the active conversation and exposes its id on the conversation top bar; the full-window URL may remain `index.html?window=full`.
- Choose **Conversation history**, then **New chat**.
- Enter text in **Do anything** and press Enter.

## Driving it with control-stella

Preconditions:

- `node .agents/skills/verify-stella/control-stella.mjs session doctor` reports healthy.
- No dialog or sidebar popover covers the composer.
- New chat requires a ready cloud conversation session. Dictation requires microphone input and permission.

- **Ready.** Run `node .agents/skills/verify-stella/control-stella.mjs chat ready`. Require `ready: true`, a non-empty conversation id, and an enabled visible composer.
- **Inspect.** Run `node .agents/skills/verify-stella/control-stella.mjs chat state`. Record the conversation id and route without exposing message contents.
- **Draft.** Run `node .agents/skills/verify-stella/control-stella.mjs drive fill --placeholder "Do anything" --value "hello from verify-stella"`, then capture `inspect aria` and `inspect screenshot` artifacts.
- **Send.** Run `node .agents/skills/verify-stella/control-stella.mjs chat send --text "hello from verify-stella"`. Require the user message or a bounded visible provider/runtime error. Do not wait indefinitely for model output.
- **Cloud working state.** Select Cloud from the execution control beside Models at the bottom of the workspace panel and send a turn that delegates a delayed task. Require Stop while Stella is responding, then no Stop or trailing working indicator after its acknowledgment, even while the background task runs. Require the same idle state after the task completion reply and after reloading. During another active cloud response, press Stop and require the turn to settle.
- **New conversation.** Run `node .agents/skills/verify-stella/control-stella.mjs chat new`. Require a conversation id different from the recorded id.
- **Dictation.** Launch with `--fake-mic <16 kHz WAV of speech>` (Chromium
  loops it as the microphone), activate "Start dictation" with a signed-in
  cloud session, wait a few seconds, then "Stop dictation and transcribe" and
  require the spoken words in the composer. There is no live preview. For the
  own-key path, run against a backend without `OPENROUTER_API_KEY` (or block
  `/api/dictation/transcribe`), require the key dialog on the first press, save
  a key, and require recording to start and transcribe.

## Gotchas

- A plain Vite browser tab lacks the Electron bridge and can paint while the composer remains disabled.
- Enter sends and Shift+Enter inserts a newline. `drive press` accepts chords such as `Shift+Enter` and `Control+KeyT` on Linux or `Meta+KeyT` on macOS.
- A live assistant reply depends on configured providers. The user turn or explicit error is sufficient for the submission path.
- Do not assert a conversation title immediately. Cloud history and title generation can update asynchronously.
