# Rich chat

Rich chat extends the primary composer and timeline with context, attachments, model/runtime controls, voice, queued work, message actions, and interactive artifacts.

## Sub-features

- `chat-context` adds files, images, browser state, or other captured context.
- `chat-model` changes the model or execution target shown for the conversation.
- `chat-voice` covers dictation and voice mode when permissions and audio are available.
- `chat-queue` queues, stops, retries, or resumes work while a turn is active.
- `chat-actions` copies, retries, or otherwise acts on a rendered message.
- `chat-artifacts` opens files, previews, citations, and agent completion output.
- `chat-replies` shows what a reply is about: an iMessage-style preview bubble above Stella's reply quoting the earlier message or task it cited, a "N replies" count under the original, and a focus view (`[data-testid="conversation-focus"]`) that dims the timeline to that message's or task's lineage. Tasks rows, inline agent cards, and reply previews all open focus; Escape or the close button returns to the whole conversation.

## How to get to it (user POV)

- Use the composer add control or drag/drop/paste supported content.
- Choose the visible model or execution-target control.
- Use microphone/voice controls when present.
- Open a message action menu or select a rendered artifact in the timeline.

## Driving it with control-stella

Preconditions:

- Start from `chat ready`. Provider-, permission-, and artifact-dependent paths need their real prerequisites.
- Seed only the smallest fixture required by the behavior under test.

- **Discover.** Run `node .agents/skills/verify-stella/control-stella.mjs inspect components` before assuming optional controls exist.
- **Attach/context.** Use `drive click` on the real add/context control, select a visible source, and require a chip or tray item before sending.
- **Model/runtime.** Open the visible selector, choose an option, then read it back from the closed control and `chat state`.
- **Keyboard.** Use `drive press --key Shift+Enter` for a newline and chord syntax for shortcuts. Assert the composer value before any send.
- **Messages/artifacts.** After a suitable turn exists, open actions or an artifact with `drive click`; require the copied-state feedback, retry state, or resulting display tab.
- **Replies/focus.** Send a request that Stella delegates, wait for the completion reply, and require `[data-testid="reply-preview"]` above it naming the task. Click the preview (or a Tasks row, or a "N replies" badge) and require `[data-testid="conversation-focus"]` with only the lineage rows; press Escape and require it gone with the timeline scroll position unchanged. The agent preview's **Report** toggle must expand the agent's full result inline.
- **Proof.** Capture before and after snapshots plus screenshots. Use bounded `diagnostics console` or `diagnostics network-summary` for failures.

## Gotchas

- Optional controls can disappear with platform capability, account state, active streaming, or narrow layout.
- File pickers and OS permission prompts may require platform-specific handling outside CDP.
- Do not fabricate a message or artifact through internal React state.
- Never expose attachment contents, tokens, or provider credentials in diagnostic output.
