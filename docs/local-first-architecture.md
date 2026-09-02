# Stella v2 local-first line

## Historical base

This line starts at `c90cee24270defe3e3ed8a3031c1ac8b72a90302`
(`feat(runtime): port dynamic model catalog and xAI OAuth`, 2026-07-17).

The boundary is structural, not based on the subject alone:

- `ed868b3f4d1c4d1625469f05f55d8f9467f43fa7` and
  `2da9aec12cd832867e53df42d700c37c6e0a2261` split and wired the
  `packages/*` workspaces.
- `92c39d6bf986814177f207a37ba6b507badf7d8d` removed the desktop
  self-modification lifecycle, Apply path, source update path, and self-mod
  HMR coordinator.
- `2588db4f6124fe02d43843490f59f9efb472eb37` made production Electron load
  built renderer files and added the packaged runtime/resources.
- `4d929a5c653563735fe8131c65500b2366e92452` retired launcher ownership of
  the desktop lifecycle. `7ca6e92a85b1a7ff633273761590d8308477a2e2`
  and `910914fe9f3678a572fa0b9102b3ebffd08712ab` completed and hardened the
  isolated packaged updater.
- At the selected tree, `packages/desktop/electron/windows/window-load.ts`
  uses `loadFile` outside explicit development mode, and the packaged files
  map copies `packages/desktop-ui/dist` to `renderer`.
- The selected tree has no Effect imports in `packages/*`. Its direct child
  `875c45ff2e0d96583e1334d43862747090c7e74b` introduces the worker-server
  Effect service rewrite and 24 Effect-importing package files, so it is the
  first excluded architectural commit.
- The selected tree predates the cloud execution work beginning with
  `ea0957e584f5958ad63ccae180b118b04ec8136b` and the cloud-canonical
  conversation series ending at `74a586520b46111f165e3db34942512f0b82c647`.

## Message ownership

Messages and conversation projections remain local:

1. Renderer chat stores call the preload `localChat` API.
2. Electron `local-chat-handlers.ts` delegates to
   `LocalChatHistoryService`.
3. `LocalChatHistoryService` opens the desktop SQLite database and uses the
   runtime `SessionStore` projections.
4. The runtime appends user, assistant, tool, activity, and file events to
   the same local store and broadcasts invalidation events back through
   Electron.

Cloud connectors and backend product APIs may exchange feature data, but
they do not become the canonical chat transcript in this line.

## Agent execution ownership

Orchestrator and General execution remains on the desktop:

1. Electron starts the packaged runtime host/worker.
2. The worker creates a local runner for each desktop conversation.
3. `runner/orchestrator.ts` and `runner/orchestrator-launch.ts` execute the
   orchestrator against its local session and persisted local history.
4. `LocalAgentManager` starts General agent turns locally and persists their
   thread/event lifecycle through `SessionStore`.
5. Provider requests and Stella-managed requests to the model gateway Worker
   (`workers/model-gateway`, `POST <gateway>/v1/relay/*` with a session
   capability) remain ordinary model networking; the agent loop and transcript
   owner stay local.

The cloud executor, cloud orchestrator, journal-socket transcript, and cloud
conversation canonicalization descendants are intentionally excluded.

## Renderer and listener boundary

Production windows resolve packaged renderer files and use `loadFile`.
Vite and its HMR socket are available only through the explicit
`electron:dev` workflow. They are not started by normal packaged launch.
Local listeners used by explicit product integrations (for example OAuth,
mobile pairing, or browser/native bridges) are separate from renderer
delivery and are not a UI hosting path.
