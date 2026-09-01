# Files and viewers

Files exposes conversation and workspace artifacts, while payload-backed viewers render supported content in the workspace display.

## Sub-features

- `files-open` launches the Files sidebar section.
- `files-list` shows loading, empty, grouped, and error states.
- `file-open` converts a selected file into a display tab.
- `viewer-kinds` covers text, code, image, audio, video, PDF, CSV, and unsupported fallbacks.

## How to get to it (user POV)

- Choose **New tab**, then **Files**.
- Select a file produced by a conversation or task.
- Select a file artifact directly from chat.

## Driving it with control-stella

Preconditions:

- The verifier is healthy. Opening a concrete viewer requires a safe fixture or an existing artifact.
- Do not inspect the user's unrelated filesystem to find a fixture.

- **Open.** Run `node .agents/skills/verify-stella/control-stella.mjs nav files` and classify the visible list state with `inspect aria`.
- **Select.** Use `inspect components` to find a named file row, then `drive click` it.
- **Viewer.** Require a workspace display tab and viewer appropriate to the file type. Capture the top bar and content.
- **Large data.** For CSV or long text, run `performance metrics` and bounded `performance trace` around open/scroll behavior.
- **Close.** Close the viewer tab and require the Files source or prior display tab to remain usable.

## Gotchas

- Empty Files is a valid state when no conversation has produced artifacts.
- CSV and long text previews must remain bounded or off the renderer hot path.
- Unsupported content should show an explicit fallback or external-open action, not a blank panel.
- File preview proof must exercise the real selection path, not call `display:readFile` directly.
