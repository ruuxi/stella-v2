# Stella v2 local-first architecture

## Message ownership

Messages and conversation projections are local:

1. Renderer chat stores call the preload `localChat` API.
2. Electron `local-chat-handlers.ts` delegates to `LocalChatHistoryService`.
3. `LocalChatHistoryService` opens the desktop SQLite database and reads the
   runtime `SessionStore` projections.
4. The runtime appends user, assistant, tool, activity, and file events to the
   same local store and broadcasts invalidations through Electron.

Connectors and backend product APIs may exchange feature data, but they do not
own the canonical chat transcript.

## Agent execution ownership

Orchestrator and General execution runs on the desktop:

1. Electron starts the packaged Effect-native runtime host and worker.
2. The worker creates a local runner for each desktop conversation.
3. `runner/orchestrator.ts` and `runner/orchestrator-launch.ts` execute against
   the local session and persisted local history.
4. `LocalAgentManager` starts General agent turns locally and persists thread
   and event lifecycle state through `SessionStore`.
5. Provider and Stella relay requests remain ordinary model networking; the
   agent loop and transcript owner stay local.

## Renderer and listener boundary

Production windows resolve packaged renderer files and use `loadFile`. Vite
and its HMR socket are available only through the explicit `electron:dev`
workflow. Local listeners used by OAuth, mobile pairing, or browser/native
bridges are separate from renderer delivery and do not own chat execution or
storage.
