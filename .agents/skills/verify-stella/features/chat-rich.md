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
- `chat-replies` keeps normal exchanges plain. When a reply returns after intervening conversation it carries one iMessage-style quote bubble above it (the cited message with a "Replying to you" label, or the task with its status glyph and a More action that opens the full report), joined by a thin connector. An original user message that later replies came back to (directly, or through a task its turn spawned) shows an "N replies" badge; adjacent answers never count. The bubble, the badge, and the original lifecycle row open a focused chain over the blurred timeline in the chat column; the focus header pill shows the chain's title, More for a task, and Close. Mobile renders the same bubbles, badge, and blurred overlay (close button, backdrop tap, or hardware back). The rule deciding all of this is shared: `packages/contracts/reply-context.ts`.

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
- **Replies/focus.** Verify an adjacent answer has no quote bubble and the ask above it has no badge. Delegate a task, discuss something else, then require one task quote bubble (status glyph, title, More) above the returning result and a "1 reply" badge under the original ask. Click the bubble's title, the badge, and the original lifecycle row separately; each must open the focused chain over the blurred timeline with a visible composer and no dialog frame. Escape, the header's Close, or a click on the backdrop restores the timeline position. The header pill's **More** (and the bubble's) opens the saved result; close it with Escape before closing focus.
- **Cloud report.** Open a completed cloud task’s focused conversation, then click **Report** in its header. Require the saved result even without a local runtime record. Reload and reopen focus and Report; the result must remain readable. An open report updates after a follow-up completes.
- **Cloud lifecycle.** Launch with `session launch --account pro`, open the workspace panel, choose **Run on This computer**, then **Cloud**. Send a request to spawn a cloud agent that waits 30 seconds before reporting. Capture the row under the spawning reply while it runs and its completed state alongside the sidebar task. Ask Stella to continue that same task with `send_input`; require a distinct follow-up row and a second completion without changing the first. Reload with `drive press --key Control+r` and require both occurrences to remain. Save screenshots and ARIA snapshots under `artifacts/cloud-lifecycle/`.
- **Working bubble handoff.** Send a short prompt and require a 200 ms quiet entrance before the dots. When the answer arrives, capture the dots bubble expanding into the text bubble over 240 ms, with fixed-size text fading in and no duplicate indicator below it. Trace the transition with `performance trace`; inspect renderer layout/paint work during the handoff. Repeat with a long reply (ordinary entrance), cancel, and reduced motion (direct appearance); require no lingering dots or Stop. History and the focused reply view must not replay the morph.
- **Send reconciliation.** Select Cloud and send one uniquely worded prompt. Require exactly one user bubble after admission, after the journal arrives, and after reload. Send the same text again intentionally and require two user bubbles; matching text alone must never collapse separate sends.
- **Proof.** Capture before and after snapshots plus screenshots. Use bounded `diagnostics console` or `diagnostics network-summary` for failures.

## Gotchas

- Optional controls can disappear with platform capability, account state, active streaming, or narrow layout.
- File pickers and OS permission prompts may require platform-specific handling outside CDP.
- Do not fabricate a message or artifact through internal React state.
- Never expose attachment contents, tokens, or provider credentials in diagnostic output.
