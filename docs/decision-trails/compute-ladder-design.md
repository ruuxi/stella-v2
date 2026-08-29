# Compute ladder for cloud general-agent turns: synthesized design

Synthesis of a four-candidate architect/arena exploration (candidates at `/tmp/arena-ladder/candidate-{1..4}/design.md` on the build VM; cross-judge verdict recorded in the PR conversation). Base: candidate 2 (resident loop + attached tool-host daemon), corrected per the cross-judge and grafted from the other three. This document is the implementation contract for Unit 3.

## Thesis

A Stella-engine general-agent turn runs its agent loop in the `BuildSession` Durable Object, following the pattern `OrchestratorSession` already proves in workerd. The Cloudflare Sandbox container attaches lazily, only when a tool that needs a real process or the world filesystem fires, and stays attached for the rest of the turn. Native engine turns (`anthropic`, `openai-codex`) and browser-handoff resumes keep today's eager-container executor path unchanged.

## Verified constraints this design is built on

1. `createToolHost` is not workerd-safe (node:crypto/path, child_process, fs, worker_threads). The DO path pins tools in code; container-only tools execute in the container.
2. `write_stdin` needs the PTY of the shell `exec_command` created, so the container side is one resident daemon per turn, not per-call execs.
3. Checkpoint archives are squashfs built inside the container (`turn-state-archive.ts`); there is no containerless archive path and none is invented.
4. `resolveTurnState` matches thread candidates on exact history-cursor equality (`turn-state-registry.ts:881-888`) and `runAgentTurn` hard-fails a present thread registry without a match (`index.ts:7017`). A DO-only turn still appends transcript rows and advances the cursor.
5. The thread candidate's only restorative payload is `native` (`index.ts:7864`); Stella turns restore nothing from it because history is rebuilt from Convex rows each turn.
6. Cloud `code` requires `browserSessionFactory` (`host.ts:500-507`, supplied by the executor at `agent-turn.ts:890-895`); Dynamic Worker Code Mode has no browser facility and blocked outbound.
7. The current pre-branch `this.sandbox(...)` at `index.ts:6950` must move; admission stops minting `sandboxId` for resident turns.

## Load-bearing decisions

**D1. One placement selector.** `selectGeneralAgentTurnPlan(execution, browserResume, killSwitch)` is the only engine-placement branch. `stella` without a browser resume → `resident_stella`; `anthropic`/`openai-codex` or a browser resume → `native_sandbox` (today's path, byte-for-byte). The decision is persisted at admission as a reasoned `TurnComputePlan` (graft from C1) so a config flip cannot re-place an admitted turn and alarm recovery reads a fact, not a guess.

**D2. Closed capability table** (graft from C3): `container | do_local | js_sandbox`, exhaustive over the general-agent catalog, failing closed on unknown names. Container: `exec_command`, `write_stdin`, `Read`, `apply_patch`, `view_image`, and `code`. Do-local: `web`, `publish_stella_interior`. `code` is classified container for the groundwork to preserve behavior parity (constraint 6); a resident Dynamic Worker fast path for browserless code is an explicit follow-up product decision, not a silent regression. The catalog is byte-identical to the container path's (names, schemas, descriptions) via metadata-only descriptor modules next to the existing defs; a catalog-parity test (graft from C1) pins node-side `createToolHost` metadata against the static catalog.

**D3. Catalog scope is unchanged.** The resident catalog adds NO tools the cloud general agent lacks today (no spawn/send_input, no Recall/Remember, no Schedule, no MCP). C2's control-plane tool expansion is cut: this is a compute ladder, not a capability change.

**D4. Attach lifecycle.** A durable `PersistedAgentCompute` record with phases `resident → attaching → attached → quiesced`. The `attaching` record (naming the sandbox id and size) is written BEFORE `createSession`, so both cancellation sweeps can destroy the exact instance whether or not boot completed; a `resident` record makes both sweeps true no-ops and Stop ACKs instantly and truthfully. Attach is single-flight and sticky. On attach: instance size from remembered-or-`initialInstanceSize`, checkpoint restore, world seeding + stella-seed check, restore confirmation, broker credential issuance (file handoff, unchanged), daemon start, drive hydration inside the daemon. `sandbox_ready` fires only when attachment actually completes (graft from C3), with `{ attachedMidTurn: true }`; the daemon's drive-hydration boot report is appended once to the attach-triggering tool's result (graft from C1).

**D5. Container transport.** The DO writes a root-owned request file outside the world and execs a small trusted client in the sandbox that talks to the daemon over a root-only Unix socket, returning one bounded result file. Exact-key parsers on both ends; `toolCallId` + argument fingerprint idempotency with receipt caching in the daemon; pending replays whose effect cannot be proven fail closed. The raw turn token appears in no bridge request, environment, or file; the daemon holds only the existing broker capability for drive routes.

**D6. Durability is a closed union.** `TurnDurability = none(reason) | transcript_only(transcript) | workspace_checkpoint(transcript, checkpoint)`. A resident-only success commits `transcript_only`: seal the per-turn SQL journal (write-ahead recovery buffer, synchronous `message_end` appends, tail repair for interrupted tool-call groups), append the exact batch to Convex, verify the canonical cursor, deliver terminal, clear the journal. No turn-state operation, no archive. An attached success runs the existing archive-before-transcript order: drain/report produced files, quiesce the daemon (join shells), optional requested interior build in a trusted session, deterministic turn-state operation, archive upload from the quiesced session, transcript append + verify, owner-world publication, retirement, teardown.

**D7. The cursor fix is subtraction** (base C2, verified independently in code and by the cross-judge): `runAgentTurn` stops treating a present thread registry without an exact-cursor candidate as an error for `stella` turns; the hard-fail remains for native engines, whose thread candidate actually restores state. Owner-world restore is already cursor-independent. Residual accepted: a thread that alternates stella → native turns can still hit the existing "start a new agent thread" error; that is the safe failure and stays. Test includes a chained run of more than eight consecutive chat-only turns on one thread (graft from C4's test plan) proving no resource exhaustion and no brick.

**D8. OOM policy.** Before any container tool has been admitted: destroy, re-attach once at `large`, retry the attach-triggering call. After a command has been admitted: never replay (the command may have crossed an external side-effect boundary); destroy the sandbox, remember `large` for the next turn, fail the turn with prior checkpoint preserved. No whole-turn replay: a durable turn has already paid for its model calls.

**D9. Recovery.** Isolate loss without cancellation: reload the compute record and journal; resident → repair the journal tail (query daemon receipts for unanswered calls when attached; mark unknown calls interrupted), append + verify, deliver failure; attached → quiesce exact process tree, archive, append repaired transcript, existing builder-fallback publication machinery. Explicit Stop keeps today's exact two-sweep contract and discards the uncommitted journal.

**D10. Effect discipline.** All new orchestration in the worker uses Effect scopes/fibers/Deferred and `TurnExecutionContext`; no new raw `setTimeout`/`AbortController` in touched files (check:ratchet gate).

## Module map

New worker modules (`workers/cloud-builder/src/`): `general-agent-turn.ts` (boundary parse, the selector, resident loop, native adapter, result types, finalization), `agent-compute-ladder.ts` (sticky attach, durable compute record, bridge calls, output reporting, checkpoint choice, scoped teardown), `general-agent-tools.ts` (pinned catalog, the capability manifest), `agent-turn-journal.ts` (per-turn SQL WAL: append/seal/repair/clear), `agent-control-plane.ts` (typed worker→Convex client: history, transcript append+verify, events, web, interior record).

New executor modules (`packages/executor-cloud/src/`): `attached-tool-protocol.ts` (wire types + parsers), `attached-tool-host.ts` (the daemon), `attached-tool-client.ts` (one-call socket client), `general-agent-prompt.ts` (workerd-safe prompt, `workspace: "lazy" | "materialized"`).

Metadata-only descriptor modules in `packages/runtime/kernel/tools/defs/` for the five container tools plus code, imported by both catalogs.

Changed: `index.ts` (admission stores compute record instead of minting sandboxId; `startAgentTurn(turn)`; the branch; interrupt hooks abort the resident Agent then run the unchanged sweeps; alarm recovery reads compute record + journal), `agent-checkpoint-policy.ts` (typed commit decision beside the legacy adapter), `cli.ts` (`--attached-tool-host`, `--attached-tool-client`), `agent-turn.ts` (imports shared prompt/catalog; native path asserts it never receives stella after activation), `package.json` exports for the workerd-safe subpaths.

Unchanged and deliberately so: `turn-state-archive.ts`, `turn-state-registry.ts` (no schema change; only the call-site relaxation in `index.ts`), `turn-credential-broker.ts` semantics (live fence derives from the compute record instead of the loose sandboxId key), `native-agent-turn.ts`, `orchestrator-session.ts`, `cloud-code-tool.ts`, browser gateway, wrangler.jsonc.

## Staging (each stage lands green on its own)

1. Extract workerd-safe prompt + tool descriptors; add the bundle test (resident import graph must not reach `createToolHost`/node-only modules) and catalog-parity test. Zero behavior change.
2. `agent-turn-journal.ts` + `agent-control-plane.ts` + the resident Agent loop with do_local tools only, exercised directly by tests (production admission untouched). Workerd fixture lands here.
3. `general-agent-turn.ts` with the selector + persisted `TurnComputePlan`; native adapter contract-tested against the current executor; admission still unchanged.
4. Daemon + protocol + `agent-compute-ladder.ts`; full pinned catalog under mock-sandbox tests; Stop-during-attach and checkpoint-ordering tests; the >8 chat-only-turns chain test; cursor-relaxation change with its tests.
5. Flip admission: `startAgentTurn` → `runGeneralAgentTurn` (kill switch env var, default resident for stella).
6. Remove the legacy in-container Stella branch from the executor once fixtures and dry-run pass.

## Synthesis note

Base: C2 (cross-judge 28/30; strongest attach lifecycle, workerd hygiene, staging, and the smallest correct cursor answer). Corrections to the base: placement now consults `browserResume` (judge finding); the claim that Dynamic Worker code supports browser suspension is removed; the control-plane tool expansion (spawn/Recall/Schedule/MCP for general agents) is cut as scope creep. Grafts: persisted reasoned placement plan + catalog-parity test + attach boot report (C1); closed capability table + `sandbox_ready`-only-on-attach (C3); code-stays-container product gate + the chained chat-only-turns test + the registry constraint documentation (C4). Rejections: C4's `cursorExtensions` registry mechanism (incomplete across `index.ts:1777-1785`, `turn-state-registry.ts:990-997`, `index.ts:1892-1898`, and unnecessary given D7), C1's broker long-poll transport (head-of-line risk against the strictly sequenced broker; the daemon socket needs no new broker targets), C3's `preserve_prior`-only durability (bricks threads, judge-confirmed), all prompt-heuristic eager attach, whole-loop mid-turn handoff, containerless archive paths, and squashfs readers in workerd. Dropouts: none; all four candidates produced complete packages.

## Verification contract for the implementation

Bun suites with `mock.module("@cloudflare/sandbox")` for placement, capability table, journal (order, bounds, tail repair, replay), attach state machine (reservation-before-boot, single-flight, never-attached Stop no-op with zero sandbox calls), durability matrix, OOM policy, cursor relaxation (stella tolerates absent candidate; anthropic still hard-fails; >8-turn chain). Protocol fixture tests parsed from both sides of the wire. Workerd fixture (`wrangler dev --local`) proving the resident import graph loads and a scripted resident turn completes with `getSandbox` uncalled. `wrangler deploy --dry-run` as the compile gate. All existing suites at baseline.
