# Rich chat

Rich chat extends the primary composer and timeline with context, attachments, model/runtime controls, voice, queued work, message actions, and interactive artifacts.

## Sub-features

- `chat-context` adds files, images, browser state, or other captured context.
- `chat-model` changes the model or execution target shown for the conversation.
- `chat-voice` covers dictation and voice mode when permissions and audio are available.
- `chat-queue` queues, stops, retries, or resumes work while a turn is active.
- `chat-actions` copies, retries, or otherwise acts on a rendered message.
- `chat-artifacts` opens files, previews, citations, and agent completion output.
- `chat-cloud-lifecycle` shows a cloud agent's spawn row, follow-up rows, and terminal state from durable lifecycle journal cards.
- `chat-replies` keeps normal exchanges plain and shows one compact work label when a reply returns after intervening conversation. The label and original lifecycle row open a focused chain in the chat column. Reply counts and quoted preview cards are absent; Report lives in the task focus header.

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
- **Replies/focus.** Verify an adjacent answer has no context label. Delegate a task, discuss something else, then require one compact task label above the returning result, with no quoted message card or reply-count badge. Click that label and the original lifecycle row separately; both must open the focused chain with a visible composer and no dialog frame. Escape restores the timeline position. The focus header’s **Report** opens the saved result; close it with Escape before closing focus.
- **Cloud report.** Open a completed cloud task’s focused conversation, then click **Report** in its header. Require the saved result even without a local runtime record. Reload and reopen focus and Report; the result must remain readable. An open report updates after a follow-up completes.
- **Cloud lifecycle.** Launch with `session launch --account pro`, open the workspace panel, choose **Run on This computer**, then **Cloud**. Send a request to spawn a cloud agent that waits 30 seconds before reporting. Capture the row under the spawning reply while it runs and its completed state alongside the sidebar task. Ask Stella to continue that same task with `send_input`; require a distinct follow-up row and a second completion without changing the first. Reload with `drive press --key Control+r` and require both occurrences to remain. Save screenshots and ARIA snapshots under `artifacts/cloud-lifecycle/`.
- **Proof.** Capture before and after snapshots plus screenshots. Use bounded `diagnostics console` or `diagnostics network-summary` for failures.

## Gotchas

- Optional controls can disappear with platform capability, account state, active streaming, or narrow layout.
- File pickers and OS permission prompts may require platform-specific handling outside CDP.
- Do not fabricate a message or artifact through internal React state.
- Never expose attachment contents, tokens, or provider credentials in diagnostic output.
