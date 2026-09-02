# Cloud turn latency: what was done, what was learned, what is next

Handoff written 2026-09-02 after a multi-day pass on desktop launch flicker,
render storms, and the per-message delay on the cloud path. Read this before
touching `OrchestratorSession`, `OwnerGate`, the owner fence, or the Convex
owner snapshot. Commits: `761394d22`, `a2b6c1fff`, and the recall/gate/splash
commits before them on `master`.

## Where things stand

Measured on the dev deployment with the verify-stella harness
(`node .agents/skills/verify-stella/control-stella.mjs session launch` /
`chat send --text ...`), six sends 45 s apart after a 3 minute idle:

| | Before | After |
|---|---|---|
| Cold send (3+ min idle) | 1,652 ms | 541 ms |
| Warm send | 356 ms | 323 to 380 ms |
| Finish call | 349 to 1,202 ms | 414 to 638 ms |

"Send" is the desktop's `POST /conversations/:id/local-turns/begin` measured
at the Worker (`conversation_local_turn_request_timing`, `durableObjectMs`).
The Durable Object logs the phase breakdown in
`conversation_local_turn_begin_timing`:
`ownerLookupMs`, `ownerFenceRegisterMs`, `initializeMs`, `finalFenceMs`.
Cold-start cost is logged as `conversation_wake_timing` and
`owner_gate_wake_timing`. No re-instrumentation is needed to measure again.

Cold breakdown after the change: gate lookup 187, fence register 122, journal
init 121, final fence 83, object wake about 30. Warm: 20 / 80 / 120 / 83.

## What the delay actually was

A begin woke three Durable Objects in sequence: the conversation object, the
per-owner `OwnerGate` (admission snapshot), and a `BuildSession` object named
`owner-purge-<sha256(ownerId)>` that hosted the owner-purge fence. Each cold
wake is 200 to 600 ms of platform cost, independent of script size. The fence
hop alone was 638 ms cold. The Worker's script startup is 52 ms, so the bundle
diet in `a2b6c1fff` did not move the message path at all. It is not harmful
(smaller upload, side-effect-free provider registration), but it was aimed at
the wrong cause. Measure the phase logs first next time.

## What was changed

- **Fence lives in the gate.** `workers/cloud-builder/src/owner-fence-do.ts`
  hosts the fence and owner turn-state authority routes; `OwnerGate.fetch`
  serves `POST /owner-fence/*`. Callers use
  `OWNER_GATES.getByName(ownerId)` with `https://owner-gate/owner-fence/...`.
  The `owner-purge-*` BuildSession host role is gone. Gate and fence share the
  single DO alarm; `OwnerGate.alarm()` runs both and re-arms at the earliest
  deadline (workerd test covers both orderings). No storage migration was
  written: there are no users yet.
- **Snapshot refresh bounds.** Synchronous fetch stays at
  `OWNER_GATE_SNAPSHOT_TIMEOUT_MS = 3_000`; background refresh uses
  `OWNER_GATE_BACKGROUND_SNAPSHOT_TIMEOUT_MS = 10_000`.
- **Convex snapshot is one query.** `getOwnerSnapshotFieldsInternal` now
  includes the allowance via `runPeekOwnerModelAllowance`
  (`gateway_capabilities.ts`), a read-only path that mirrors
  `getOwnerModelAllowanceInternal` without creating billing rows or patching
  usage windows. Equivalence is tested for anonymous, signed-in with billing
  rows, and signed-in with none. The mutation remains for its other callers.
- **Cold-start timing logs** on both objects.

## What was tried and reverted

Pre-warming the gate with `scheduleOwnerSnapshotChanged` from Better Auth's
user `onCreate` trigger. It worked, and it made every warm send slower: the
push created the gate object next to Convex's servers, so every later hop
from the conversation object crossed a continent (70 to 125 ms per hop
instead of about 15). Removed. The desktop's conversation socket already
creates and warms the gate from the user's own edge at launch.

Rule: a per-user or per-conversation Durable Object must be first touched by
a request from the user's edge. Convex pushes may target objects that already
exist; never use them to create one.

## Steps 1 to 3 landed (2026-09-02, branch `claude/cloudflare-durable-objects-doc-jwg5x0`)

Not yet measured on the dev deployment: the session that landed these could
not deploy. Measure with the recipe at the bottom before trusting the numbers
in "Next steps"; the phase labels below say what each timing now covers.

- **Step 1, fence register folded into the snapshot call.**
  `OwnerGate.snapshotWithFenceLease` (an RPC method, `owner-gate.ts`) serves
  the cached snapshot and, only when that snapshot is writable at the
  caller's generation, runs the colocated fence's `register` in-process
  through the same `OwnerFenceHost` that `POST /owner-fence/register` uses.
  A stale or fenced-off caller never leaves a lease behind. A snapshot the
  gate cannot obtain comes back as a value, so the caller can tell "nothing
  registered" from a lost response. On the conversation side,
  `registerOwnerTurn` takes a register transport; the receipt protocol
  (`ownerFenceLeaseReceipt:*`, run slots, replay, uncertain-response
  handling) is untouched. `handleLocalTurnBegin` now does only the local
  half of the owner check (`localTurnCaller`) before validating the request,
  then `registerOwnerTurnWithSnapshot`, then applies the snapshot with
  `adoptOwnerSnapshot` (the write fence, adoption, generation persist that
  `resolveOwnerForCaller` still does for every other route). Consequence for
  the phase log: `ownerLookupMs` is now local work only and
  `ownerFenceRegisterMs` is the one gate round trip. The replay branch (an
  existing local lease for the same turn) keeps the separate snapshot read
  and its two fence asserts; it is rare.
- **Step 2, remote asserts dropped from the begin path.** Both the assert
  before the response and the one inside `initializeLocalTurn` after the
  prompt spill (the doc above did not list that second one; it was the bulk
  of the 120 ms "journal init") are gone. Verified against
  `beginOwnerPurge` in `index.ts` and the `/owner-purge-cancel` handler: a
  purge that begins after register finds the lease in the fence's `active`
  map and calls this object, which cancels the exact local lease (or retires
  an orphaned receipt) before the purge can report quiescence; the local
  lease re-read after `initializeLocalTurn` catches it. The remote assert only
  moved that failure earlier. `finalFenceMs` keeps its name and now times the
  local re-read only. Cloud turns (`/turn`) and voice appends are unchanged.
- **Step 3, gate keepalive.** `OWNER_GATE_PRESENCE_KEEPALIVE_MS = 30_000`:
  `scheduleAlarm` arms an alarm at most that far out while a proven presence
  socket is attached, and every `alarm()` re-arms it. Unproven sockets do not
  count. This is the one change the doc said to measure first; it was not.
  If the second-send bump is gone after steps 1 and 2, delete the constant
  and the three lines in `scheduleAlarm` that use it.
- **Step 4 not done**: no Docker in that session. The dev container image
  still needs rebuilding from a shell with Docker.

Tests: `tests/owner-gate-fence-lease.test.ts` (the combined call against the
real fence store), the local-turn begin cases in
`tests/execution-placement-turn-cancellation.test.ts` (one gate call, replay
without a second register, stale generation and fenced-off owner register
nothing), and the keepalive cases in `tests/device-presence-socket.test.ts`.

## Next steps, in order of value (as written before steps 1 to 3 landed)

1. **Fold fence register into the snapshot call.** The gate already has the
   owner in hand when it serves the snapshot. Returning the fence generation
   from the same RPC removes one round trip (about 80 ms warm). Touches
   `registerOwnerTurn` in `orchestrator-session.ts` and the gate's `snapshot`
   / fence host. Keep the durable receipt protocol
   (`ownerFenceLeaseReceipt:*`) exactly as is; only the transport changes.
2. **Drop the remote assert before the begin response.** `finalFenceMs` is a
   second fence RPC guarding the window between register and response. The
   purge flow already cancels active leases through the conversation object,
   and `assertOwnerFenceLeaseReceiptActive` runs the local check inside the
   lease acquire. Verify that claim against the purge tests
   (`tests/owner-fence-lease-workerd.test.ts`,
   `tests/owner-transfer-coordinator-do-workerd.test.ts`) before removing it.
   About 80 ms warm. Steps 1 and 2 together should land warm sends near 150
   to 200 ms.
3. **Gate keepalive while a presence socket is connected.** The gate
   hibernates after roughly a minute idle and the next lookup costs about 170
   ms. An alarm every 30 s while `device_presence` has a live socket keeps it
   resident. Cheap, but measure the second-send bump first to confirm it
   still matters after steps 1 and 2.
4. **Rebuild the dev container image** from a shell with Docker. Every deploy
   this pass used `--containers-rollout=none`; the image still runs the
   runtime revision before the provider-registration change. It is
   self-consistent, but it should match.

## Things that are done and should not be reopened

- Hub split / socket hub object: premise was script-size wake cost, which is
  52 ms. Not worth doing for latency.
- Executor split (BuildSession and sandboxes to a separate Worker): cost
  neutral, latency neutral. Only if wanted for its own sake.
- Effect subpath imports, residual `zod` via the Anthropic adapter: bundle
  only, no latency effect.
- Recall index: lives in the conversation object (FTS5, `journal_fts`); the
  Convex excerpt tables and `/api/cloud/recall` are deleted. Agent threads
  have a parallel `thread_fts` but no Recall tool yet by product decision.

## Known pre-existing test failures (not from this work)

- `workers/cloud-builder`: two sandbox egress tests need Docker.
- `packages/backend`: `managed_alternate_writer_inventory` and
  `managed_paid_callsite_receipts` (the latter counts callsites in an
  uncommitted `http_routes/synthesis.ts`).
- `packages/desktop-ui`: `context-model-precedence`,
  `stella-browser-release-contract`.

## How to measure again

1. Deploy: `cd packages/backend && bunx convex dev --once`, then
   `cd workers/cloud-builder && npx wrangler deploy --env="" --containers-rollout=none`.
2. Capture logs: the Convex `CLOUDFLARE_API_TOKEN` and the wrangler OAuth login
   both lack the observability query scope, so use
   `npx wrangler tail --env="" --format json > tail.jsonl` (the output is
   pretty-printed JSON objects, not JSONL; parse with a `raw_decode` loop).
   Tail sessions drop silently; run two staggered loops and dedupe.
3. Drive the desktop with the harness: `cleanup apply`, `session launch`,
   `chat ready`, wait 3 min, then `chat send --text ...` several times 45 s
   apart. Read `conversation_local_turn_begin_timing` and
   `conversation_local_turn_request_timing`.
4. Ignore `wallTime` on OwnerGate fetch events in tail output. It measures
   until the next event arrives at that object, not the handler's duration.
