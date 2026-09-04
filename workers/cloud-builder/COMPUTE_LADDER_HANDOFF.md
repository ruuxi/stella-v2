# Compute ladder handoff: context, what just landed, what is next

Written 2026-09-03 for the agent that picks this up on a machine with Docker
and the dev deployment credentials. Read this before touching
`workers/cloud-builder`, `packages/executor-cloud`, or the cloud placement
code in `packages/runtime/kernel/runner`. Verify anything here against the
code; the code is authority.

## 1. Where the architecture stands

Stella is one long-running chat. The orchestrator only spawns agents; agents
do the work, locally on the user's computer or in the cloud.

What master already has on the cloud side (all in `workers/cloud-builder`):

- `OrchestratorSession`, one Durable Object per conversation, owns the
  transcript in its SQLite journal (gapless `seq`, idempotent `writer_key`,
  FTS transcript index, R2 rollover of cold segments). Convex holds only a
  projection fed by the `TURN_OUTBOX` queue. Clients read history over one
  hibernatable WebSocket per conversation (`conversation-hub.ts`).
- `BuildSession`, one per agent thread, runs the general-agent loop resident
  in the DO (`general-agent-turn.ts`). A Cloudflare Sandbox container attaches
  lazily on the first tool that needs a process or the world filesystem and
  stays attached for the rest of the turn (`agent-compute-ladder.ts`,
  `agent-sandbox-attachment.ts`). Inside the container a root daemon
  (`packages/executor-cloud/src/attached-tool-host.ts`) serves the bridged
  tools over a root-only Unix socket; the DO relays one call at a time through
  a request file, a one-shot client, and a bounded result file.
- The closed capability table (`general-agent-tools.ts`) is the whole ladder:
  `exec_command`, `write_stdin`, `Read`, `apply_patch` are `container`;
  `code` is `js_sandbox` (a Dynamic Worker); `web` and
  `publish_stella_interior` are `do_local`. `Grep`, `Write`, `Edit` do not
  exist in the cloud.
- The world filesystem lives only in the container and survives as squashfs
  archives in R2 (`turn-state-archive.ts`), restored on every attach.
  Containers are per turn attempt, never kept warm. Instance classes are
  standard-2 (small) and standard-4 (large); a cold world starts large.
- Placement (`OwnerGate`, `dispatch-policy.ts`, contracts
  `execution-placement.ts`) offers desktop and mobile turns to a present
  paired computer first and falls back to cloud, never for dispatches that
  need computer-use or local files.
- The model gateway (`workers/model-gateway`) is the single model egress with
  capability JWTs; the browser gateway (`workers/browser-gateway`) wraps
  Browser Rendering behind a closed action allowlist.

Assessment of that design against the isolate-first target (an agent that is
cheap because it is not in a sandbox, escalating only when a tool needs it):

- Right: the orchestrator DO, the ladder's lifecycle engineering (placement
  persisted at admission, attach record written before boot, exact Stop,
  journal recovery), the device tier, the model and browser gateways, the
  security posture (uid 42424 drop, one-shot credential handoff, openat-style
  file boundary, egress policy).
- Off: the isolate tier is nearly empty. Any file read boots a 6 or 12 GiB
  container that is rebuilt from a squashfs archive and held for the rest of
  the turn. Concurrency is one agent per owner world because the world lives
  in one container. Cloud generals cannot spawn. Cloud mode has no
  compaction, only a newest-suffix token window. The desktop orchestrator and
  the cloud orchestrator are two writers of one journal
  (`orchestrator-launch.ts` lease + ephemeral capture vs. the DO loop).
- The September evaluation of ascii.dev Box (in git history under
  `docs/decision-trails/sandbox-provider-ascii-box.md`, commit `6f648b539`)
  treats the container bill as a vendor problem. It is a classification
  problem: files force a large container. Shrink the container's job before
  swapping providers.

Bundle facts, measured with esbuild the way workerd sees the Worker: the
full Worker evaluates about 3.1 MB on every DO wake, of which the runtime
package contributes about 0.16 MB (37 files). The Worker's own source is
1.56 MB, the sandbox SDK 0.61 MB, Effect 0.39 MB, ajv 0.25 MB. The runtime's
size and Bun reliance are not what is heavy; they are quarantined by
`tests/general-agent-resident-bundle.test.ts`. The weight lives in the
container image, which bakes Bun plus the whole runtime.

## 2. What commit `0cb42b380` fixed (this handoff's commit)

Three defects from the live verification run, each traced to a line.

**Follow-up daemon death.** Only follow-up turns restore a checkpoint, and
every archive script in `turn-state-archive.ts` began with `set -eu` and
`umask 077` (locked ones also `exec 9<>` the lock) and ran unwrapped in the
session's persistent shell. The daemon was started in that shell; the first
non-zero command after readiness ended the shell and the container reaped
the daemon with SIGKILL and empty stderr. Fixes: `runCommand` wraps every
archive script in the shared `inSubshell` helper (`shell-subshell.ts`); the
daemon is started on the sessionless facade via the new
`startDaemon` attachment dependency; a shell that exits under a bridge call
surfaces as a tool error and one `attached_session_terminated` event.

**Container leak.** In sandbox SDK 0.12.9 keep-alive is a persisted flag that
disables the idle stop (no ping), and any container RPC after `destroy()`
boots a fresh instance. Termination built a keep-alive-on stub and called
`killAllProcesses` before destroy; the release ran through
`Function.prototype.call` on a detached RPC property. Fixes: the process
sweep runs only when `getState()` on the sandbox object says the container is
running (`sandboxContainerRunning`); retirement never holds a keep-alive stub;
the release is a method call; `SANDBOX_IDLE_TIMEOUT_MS` is passed as the
SDK's `sleepAfter` (`sandboxHandle`); new bearer route
`POST /internal/sandboxes/retire` and `scripts/retire-sandbox-adapter.mjs`
give `scripts/retire-sandbox-instances.mjs` its missing adapter.

**Deferred destroy.** The timeout and executor-loss paths treat a
`SandboxLifecycleDeferredError` as alarm-owned debt and deliver the terminal;
a fiber still held past its watchdog is interrupted and its handle dropped in
`runScheduledTurnAlarm`. The bearer route `POST /sessions/:id/expire` (DO path
`/expire-agent-turn`) expires a wedged thread now.

Verification in a no-Docker, non-root environment: cloud-builder 975 pass,
2 fail (Docker-backed egress workerd fixture, identical on the base commit);
executor-cloud 157 pass, 2 fail (root-only Linux boundary tests, identical on
the base commit); worker typecheck, `wrangler types --check`,
`lint:promises` clean; `check:ratchet` no longer reports cloud-builder.

## 2b. 2026-09-03 evening: section 3 done, one more leak fixed

Run from a machine with Docker and the dev credentials. Dev worker versions
`49cff631` (commit `0cb42b380`) and `86400928` (this commit).

- The six leaked small containers were reaped with the retire script. Two
  script defects on the way: the adapter was not executable, and the
  inventory classifies every `agent-*` instance as
  `agent-or-resident-attachment` (it cannot tell the two apart without a
  durable export), which the route rejected as `invalid_target`. The adapter
  now resolves that classification to the first candidate; both candidates
  address the same namespace, the Worker keys it on `app-build` versus size.
- The wedged thread `14e0abfd…` was `failed` after the deploy's own recovery;
  `POST /sessions/:id/expire` answered `404 no_agent_turn`, which is correct.
- The follow-up cell passed on both versions: `sandbox_ready` on both turns,
  the restored daemon served `Read`, final content `hello world`, no
  `attached_session_terminated`, no `sandbox_keep_alive_release_failed`.
- The first run also showed a leak the previous fix did not cover: a
  **completed** resident turn left its container running with keep-alive
  persisted (both turns' containers, 18 minutes and counting, no destroy
  RPC in the tail). Cause: `runResidentAgentTurn` delivered the terminal,
  whose delivery deletes the turn's storage including the exact compute
  record, and only then ran `ladder.teardown()` in `finally`;
  `terminateCurrentAgentSandbox` resolves its target from that record, found
  nothing, and returned without a destroy. Fix in this commit:
  `finishResidentAgentTurn` releases the compute before delivery, a deferred
  destroy releases the world slot early (same rule as the watchdog path),
  and the `finally` sweep runs only on an exceptional exit. Regression tests
  in `tests/general-agent-resident-recovery.test.ts`. Verified live:
  `sandbox_destroyed` (`agent_termination`) 0.1 s before the completed event,
  small-class inventory zero within 12 s of completion on both turns. This
  is very likely where the original six leaks came from.
- `.agents/skills/verify-stella/cloud-turn.mjs` gained `--email` so a
  follow-up can re-enter a conversation as the same owner; the harness also
  exits on the orchestrator's first `completed` row, so poll `agent_events`
  yourself for the agent thread.

Operational facts learned:

- A deploy that changes the image rolls the container application; for
  about ten minutes afterwards the platform still counts the old instances
  against `max_instances`, `wrangler containers instances` shows them
  `inactive`, the application `health` block still says `healthy`, and a new
  attach loops on "Maximum number of running container instances exceeded"
  (the follow-up attach took 6 minutes on the first run, 14 s once settled).
  The retire script's exact-live check also flaps during that window.
- `wrangler tail` drops most log lines of long Durable Object invocations
  (an alarm-driven turn shows as one object with zero logs). Workers Logs
  are enabled, but the telemetry query API needs an observability scope
  that neither the wrangler OAuth login nor the Convex-held API token has.
- There is no `lint:promises` script anywhere in the repo; `check:ratchet`
  runs from the repo root and scans `workers/cloud-builder/.image/` if a
  deploy is staging at the same time.
- The Convex-held `CLOUDFLARE_API_TOKEN` cannot list containers; the wrangler
  login can.

Follow-ups worth a look, not done:

- `destroySandboxDurably` writes its debt record before the destroy attempt,
  so a watchdog alarm firing in the same instant retries the same target
  (`sandbox_destroyed` twice at 00:11:53.723, reasons `agent_termination`
  and `alarm_retry`). Harmless on a container that is already gone, but a
  destroy RPC on a reset sandbox object is the revival path; the debt should
  probably be claimed by the in-flight attempt.
- Escalating this leak into the durable record itself (make
  `deps.destroy(sandboxId)` use the id it is handed, plus size from the
  ladder record, instead of re-reading storage) would make the teardown
  order-independent.

## 3. Do these first, in order (needs Docker and dev credentials; done 2026-09-03, repeat after any deploy)

1. Confirm no dev thread is `running`:
   `cd packages/backend && bunx convex data cloud_agent_threads --limit 5 --order desc`.
   Never deploy while one is; the deploy replaces the resident isolate.
2. Deploy: `cd workers/cloud-builder && bun run deploy:dev` (about two
   minutes worker-only; the image is unchanged by this commit).
3. Reap the six leaked small containers:
   `node scripts/sandbox-inventory-report.mjs --environment dev` to list
   orphans, then
   `CLOUD_BUILDER_URL=... BUILDER_SERVICE_SECRET=... node scripts/retire-sandbox-instances.mjs --environment dev --instance-id <id> ... --apply --confirm <printed> --adapter scripts/retire-sandbox-adapter.mjs`.
   Confirm the small class inventory reads zero afterwards.
4. Unwedge the earlier test owner: bearer
   `POST $CLOUD_BUILDER_URL/sessions/<threadId 14e0abfd…>/expire` with an
   empty JSON body. If new attaches still get the owner-purge message,
   `owner_purge_temporary` means a temporary purge was begun on that owner and
   must be released once its leases expire.
5. Re-run the follow-up cell: one conversation through
   `.agents/skills/verify-stella/cloud-turn.mjs`, a first turn that reads a
   file, then a `send_input` follow-up. Expect the daemon to survive, no
   `attached_session_terminated` event, and `sandbox_ready` on both turns.
6. Read the `errorName` field on any remaining
   `sandbox_keep_alive_release_failed` log line. `TypeError` would mean the
   method-call fix was the whole story; `Error` with 48 detail bytes is the
   10 second deadline and points at a reset sandbox object.

## 4. The ladder work, in order

Each item is a design-then-code unit. Land them one at a time behind the
existing closed capability table and its parity test
(`packages/executor-cloud/src/general-agent-catalog-parity.test.ts`).
Keep the workerd fixtures (`tests/*-workerd.test.ts`) green at every step.

### 4.1 Workspace in the Durable Object (Tier 0)

Goal: `Read`, `apply_patch`, plus new `Write`, `Edit`, `Grep`, and glob run
in the isolate against a SQLite-backed world, so a follow-up that only reads
and patches never attaches a container.

- Storage: a content-addressed chunked filesystem in `BuildSession` (or a new
  per-owner world DO; decide first). Tables: nodes (inode: type, mode, size,
  mtime), dirents (parent, name, node), chunks (sha256, bytes) with 512 KiB
  chunks, manifests per checkpoint, tombstones. Row cap is 2 MB, so chunking
  is mandatory; spill blobs above a few MiB to R2 (`AGENT_HOME` is the wrong
  bucket; add a world bucket). Reference designs: Turso AgentFS, Cloudflare
  `@cloudflare/dofs` (preview, copy the schema, do not depend on it).
- Tools: implement over the VFS in workerd-safe modules under
  `workers/cloud-builder/src/` (not `packages/runtime/kernel/tools`, which
  is Node-only). Grep in TypeScript over the VFS, no ripgrep. Keep the exact
  tool names, schemas, and descriptions the container path emits; add
  `Write`, `Edit`, `Grep` descriptor modules beside the existing
  `*-def.ts` files so both catalogs stay byte-identical.
- Reclassify in `general-agent-tools.ts`: `Read`, `apply_patch`, `Write`,
  `Edit`, `Grep` become `do_local`. `exec_command` and `write_stdin` stay
  `container`.
- Authority: the DO world is the source of truth from the first turn that
  lands this. The squashfs archive path stays for the container (see 4.2).

### 4.2 Container as a projection of the DO world

Goal: the container never owns the world. On attach, materialize the world
from the DO's chunks into `/workspace/world`; on quiesce, diff the tree and
write changed files back as chunks. The squashfs archive becomes a backup
path, then goes away.

- Attach: replace `restoreTurnStateArchive` in `attachAgentWorld` with a
  materialization step (stream a tarball of the manifest through the
  session's `writeFile`, or per-file writes for small trees). Keep
  `normalizeToolWorkspaceRoot` and the seed check.
- Quiesce: the daemon already reports produced files; extend the quiesce
  control to return a manifest diff (path, mode, sha256, size) and stream
  changed bytes back through the broker.
- Then drop the default instance size to standard-1 and keep standard-4 for
  the `HEAVY_STACK_PATTERN` in `instance-size.ts` and remembered OOM.
- Do not adopt `@cloudflare/computer` FUSE projection yet; it is preview and
  "not suitable for production" as of August 2026.

### 4.3 Per-agent world forks

Goal: lift the one-agent-per-owner-world rule
(`owner-gate.ts` around the world lease) and let cloud generals spawn.

- Content-addressed chunks make copy-on-write forks nearly free: a fork is a
  new manifest pointing at the same chunks. Each spawned agent gets a fork;
  completion reports a diff back to the parent world, applied by the
  orchestrator DO or merged by rule (last writer wins per path is acceptable
  at first, with conflicts surfaced in the completion wake).
- Revisit design decision D3 in the ladder design doc (git history,
  `docs/decision-trails/compute-ladder-design.md`, commit `413ebbf84`):
  the cloud general catalog omitted `spawn_agent` and friends as scope
  control, not as a product rule.

### 4.4 Compaction in the DO

Cloud mode prunes to a 48,000 token newest-suffix window
(`packages/executor-cloud/src/prune-history.ts`). The local runtime's
head + checkpoint + tail model with summaries
(`packages/runtime/kernel/agent-runtime/compaction-scheduler.ts`,
`thread-memory.js`, `resident-context.js`) is pure logic. Port it into the
orchestrator DO's journal as a materialized checkpoint row and use it for
context assembly.

### 4.5 One orchestrator

Desktop ingress still runs the orchestrator locally against the remote
journal (`orchestrator-launch.ts`: lease, begin/finish, ephemeral thread
capture, compaction suppressed under capture). Once the cloud orchestrator
has a workspace (4.1) and device tools over the presence socket (Read of
local files, html, image_gen, map, computer-use), desktop ingress can commit
to the DO like every other ingress and that dual-writer seam can be deleted.
Do this last.

## 5. Constraints and gotchas to keep in mind

- Durable Object limits: 128 MB per isolate shared across DOs of the class
  on a machine, 2 MB per SQLite row, 30 s CPU per invocation (raise via
  `limits.cpu_ms`), alarms 15 min wall, 6 simultaneous outbound connections
  awaiting headers.
- Every `session.exec` shares one persistent shell per session. Anything a
  script sets on the shell outlives the call. Wrap strict scripts in
  `inSubshell`. The readiness probe already answers on stdout for this
  reason.
- Every container RPC after `destroy()` boots a fresh instance. Ask the
  sandbox object (`getState`), never the container, before a teardown call.
- `keepAlive` is ignored by `sleepAfter`; a live turn keeps the container
  awake by RPC activity plus the persisted flag. Only teardown stubs and the
  operator retire route pass `keepAlive: false`.
- Effect ratchet (`bun run check:ratchet`) rejects new raw `setTimeout` or
  `AbortController` in touched files. The pre-existing hits in
  `packages/runtime/observability/remote-telemetry.ts` are not yours.
- Worker startup: the resident import graph must not reach
  `packages/runtime/kernel/tools/host.ts`, `node:fs`, `child_process`, or
  `worker_threads` (`tests/general-agent-resident-bundle.test.ts`). Load
  anything heavy through a dynamic import on first use, as the code tool
  does.
- `SandboxSmall` has `max_instances` 6 in dev; a leak fills it.
