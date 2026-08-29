# Effect ownership audit (M5 phases 1–4)

Status: the runtime ownership migration is **materially complete** as of
phase 4. Every seam that owns run- or worker-lifetime is Effect-owned;
what remains imperative is boundary or pure-transform code, each entry
retained deliberately with the reason recorded below. Do not migrate the
retained seams without new evidence — that would be architecture for
aesthetics.

## Effect-owned lifetime seams

| Seam                                              | Owner                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker RPC services + session graph               | `worker/server/` Layers; teardown order documented in `worker/server/sessions.ts`                                                                                          |
| Host worker lifecycle (lock/spawn/kill/readiness) | `host/lifecycle/` Scope + Schedule                                                                                                                                         |
| Orchestrator lane admission + queued-turn drain   | `kernel/runner/run-coordinator.ts`                                                                                                                                         |
| Run fiber tree (turns, subagent attempts)         | `kernel/runner/supervision/run-supervisor.ts` over `shared/supervised-scope.ts`                                                                                            |
| Provider streams (delivery + lifecycle)           | `agent-runtime/provider-stream-lifecycle.ts` (true Stream pipeline; relay abort; bounded joins) + `ai/stream.ts` pipeStream                                                |
| Tool executions                                   | `agent-runtime/tool-lifecycle.ts` (child signals, duplicate guard, bounded joins)                                                                                          |
| External engine turns                             | `agent-runtime/external-engine-lifecycle.ts` (relay → kill ladder, bounded joins)                                                                                          |
| Compaction scheduling                             | keyed SupervisedScope executors (single-flight pinned)                                                                                                                     |
| Cancellation                                      | one joining interrupt: `cancelLocalChat` → `supervisor.cancelRun`                                                                                                          |
| Boot readiness                                    | `shared/readiness-latch.ts` (Deferred; reset on stop)                                                                                                                      |
| Subagent settlement                               | `LocalAgentManager.waitForAgentUpdate` (notify at persistTask; SQLite truth)                                                                                               |
| toolHost shutdown                                 | idempotent memoized finalizer sequence; shell exits joined (3s bound) → repl kernels                                                                                       |
| Shell exit joins                                  | `kernel/tools/host.ts#killShell` — event-driven join on the shell's exit latch, 1.5s bound (was a 25ms poll)                                                               |
| RunEventLog retention sweep                       | fixed-rate fiber in `kernel/storage/run-event-log.ts` with a cancel thunk (was an unref'd `setInterval`); host timers (heartbeat, debounces) ride `host/effect-runtime.ts` |

## Retained imperative seams (deliberate, with reasons)

- `ai/utils/resilient-event-stream.ts` — reconnect/backoff state machine.
  Timers/listeners are finally-scoped and its single consumer runs under a
  run-scoped fiber; a
  Stream/Schedule rewrite risks resume-cursor parity for zero ownership
  gain.
- Provider adapters (`ai/providers/*`) — boundary code over SDKs/fetch.
  Network lifetime derives from run-scope relay signals (phases 2–3);
  bodies close exactly once on every reader exit path (phase 4).
- Claude Code / Codex stdio framing — protocol boundary code. Process
  lifetime is scope-joined via engine-turn resources + kill ladders;
  pendings settle exactly once; durable session ids/resume are covered by
  the integrations suites incl. the split-frame reassembly pin.
- One-shot utility spawns (`ripgrep`, `search`, `private-fs`,
  `deferred-delete-cli`, `schedule-scripts`) — per-call awaited children;
  `schedule-scripts` kills on abort/timeout. No persistent lifetime.
- CLI entrypoints (`stella-connect`, `stella-computer`, `native-helper`)
  and `connector-bridge` — sidecar-process boundary code owned by their
  own process lifetimes (`closeConnectorBridgeSessions` on the CLI side).
- Pure async transforms (prompt building, thread memory, image
  pipelines) and renderer/IPC facades — no lifetime ownership; stay
  imperative by design.
