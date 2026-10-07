# Chat

Chat is Stella's primary desktop surface. Stella is one long-running conversation: the user writes in the real composer and sends a turn through the selected execution target. The desktop has no conversation history, tabs, or New chat control (removed from the top bar in `b42051c1b`); the active conversation is chosen by the root route (`?c=`).

## Sub-features

- `chat-ready` resolves an active conversation and enabled composer.
- `chat-draft` accepts text without mutating the timeline.
- `chat-send` shows the user turn or a visible provider/runtime failure.
- `chat-dictation` records with a waveform pill. When the backend reports
  `streaming: true` on `GET /api/dictation/transcribe`, signed-in users stream
  over `/dictation/socket` and see live partial text; a socket that fails ends
  the session with a visible dictation error. Otherwise the whole recording is
  transcribed when stopped (managed `/api/dictation/transcribe` with
  `microsoft/mai-transcribe-2`, or the user's own OpenRouter key through
  Electron main). A Stella without managed dictation and no saved OpenRouter
  key opens "Turn on dictation" instead.

## How to get to it (user POV)

- Launch Stella. Electron creates or restores the active conversation; its id is on the chat surface (`[data-testid="chat-surface"][data-conversation-id]`) and the full-window URL stays `index.html?window=full`.
- An empty conversation opens on the Home overlay with a centred composer; after a send the timeline replaces it.
- Enter text in **Do anything** and press Enter.

## Driving it with control-stella

Preconditions:

- `node .agents/skills/verify-stella/control-stella.mjs session doctor` reports healthy.
- No dialog, menu, or popover covers the composer.
- A clean, empty conversation needs a fresh `session launch --replace`. Dictation requires microphone input and permission.

- **Ready.** Run `node .agents/skills/verify-stella/control-stella.mjs chat ready`. Require `ready: true`, a non-empty conversation id, and an enabled visible composer.
- **Inspect.** Run `node .agents/skills/verify-stella/control-stella.mjs chat state`. Record the conversation id and route without exposing message contents.
- **Draft.** Run `node .agents/skills/verify-stella/control-stella.mjs drive fill --placeholder "Do anything" --value "hello from verify-stella"`, then capture `inspect aria` and `inspect screenshot` artifacts.
- **Send.** Run `node .agents/skills/verify-stella/control-stella.mjs chat send --text "hello from verify-stella"`. Require the user message or a bounded visible provider/runtime error. Do not wait indefinitely for model output.
- **Cloud working state.** Select Cloud from the execution control beside Models at the bottom of the workspace panel and send a turn that delegates a delayed task. Require Stop while Stella is responding, then no Stop or trailing working indicator after its acknowledgment, even while the background task runs. Require the same idle state after the task completion reply and after reloading. During another active cloud response, press Stop and require the turn to settle.
- **Dictation.** Launch with `--fake-mic <16 kHz WAV of speech>` (Chromium
  loops it as the microphone), activate "Start dictation" with a signed-in
  cloud session, wait a few seconds, then "Stop dictation and transcribe" and
  require the spoken words in the composer. There is no live preview. For the
  own-key path, run against a backend without `OPENROUTER_API_KEY` (or block
  `/api/dictation/transcribe`), require the key dialog on the first press, save
  a key, and require recording to start and transcribe.

## Gotchas

- The renderer is served from source over `stella-app://desktop/`; only the harness-owned Electron page has the bridge. Do not open the renderer in a plain browser.
- `chat ready` can report `ready: false` for a few seconds after launch while the conversation id resolves; retry before reporting a failure.
- `chat send` works from Home (it fills the Home composer and watches the chat surface). `composerCleared` can read false right after a Home send because the composer it sampled is the one being swapped out; check `inspect state` instead.
- Enter sends and Shift+Enter inserts a newline. `drive press` accepts chords such as `Shift+Enter` and `Control+KeyT` on Linux or `Meta+KeyT` on macOS.
- A live assistant reply depends on configured providers. The user turn or explicit error is sufficient for the submission path.
- Do not assert a conversation title immediately. Cloud history and title generation can update asynchronously.
