# Native runtime migration

This is an **incomplete replacement**, not the default desktop runtime. Electron
and the cloud-builder still default to `packages/runtime`. Desktop can select
the native binary explicitly for integration verification. Native health reports
transport/execution readiness separately from `parityComplete: false`; readiness
does not establish complete service or tool parity.

Implemented here:

- A native `stella-runtime` process with JSONL over stdio, Unix sockets, and a
  Windows named-pipe implementation (the latter has not been run on Windows).
- `rusqlite` with bundled SQLite/FTS5, schema versions 0–3, WAL, exclusive
  migrations, legacy transcript/thread/blob/compaction import, and preservation
  of existing outbox and receipt tables.
- Transactional chat writes, sequence allocation, overwrite-by-ID, turn
  ownership, reply references, transcript search, settings, and summary records.
- Duplex host callbacks, existing unversioned v1 RPC envelopes, concurrent
  requests, protected host signing, detached lifecycle control files and signals.
- RPC run admission/cancellation, durable event replay/acknowledgment in the
  existing `stella-runs.sqlite`, and interrupted-run settlement on restart.
- Bounded concurrent tool execution with pre-execution deduplication and stable
  transcript order; local prompt steering with reply ownership, queued turn
  serialization, and bounded transient gateway retries.
- Signed-in desktop cloud turn admission/renewal/finish through the existing
  Durable Object, with a native transcript outbox and interrupted-begin recovery.
  Other outbox families and full recovery parity remain below.
- Compiled Rust agent metadata and prompt-reminder policy in `../runtime-core`.
- A standalone Rust agent loop and managed model-gateway execution using
  Ed25519 capability exchange, DPoP, descriptor revisions, and the Responses and
  Chat Completions protocols. The current standalone tool adapter implements
  bounded text/image `Read`, with file guards, scoped descriptor reads on Unix,
  UTF-16-compatible hash anchors, and skill-read deduplication. Tool images are
  forwarded through both managed protocols. Native `apply_patch` supports add,
  update, move, delete, tolerant matching and already-applied receipts. Mutations
  use sorted file locks, descriptor-pinned directories, regular-file/link checks,
  verified writes, and cancellation settlement. It is not the complete Stella tool pack.
- Native shell pipes and PTY/ConPTY implementation, conversation/thread access
  control, serialized interactions, idempotent writes, resize/EOF/termination,
  bounded output and cursor receipts, completed-session retention, and the
  catastrophic-command guard. Linux pipes and PTYs have been exercised with
  real model-driven input, large output, and cancellation. Windows remains
  unverified; CLI integrations and progress forwarding still need completion.
- Provider-context reconstruction preserves exact stored messages while repairing
  dangling/interleaved tool results, dropping foreign reasoning signatures and
  downgrading images for models without vision.
- Managed catalog discovery over the authenticated backend endpoint, account/device
  cache isolation using the existing disk format, stale refresh, concurrent fetch
  coalescing, gateway discovery, compiled provider metadata, and model-list RPC
  notifications. Native JSONC provider configuration, schema validation, model
  overrides, private provider cache persistence and bounded remote refresh are
  connected to listing; credential expressions are never executed for listing.

## Build and run

From the repository root:

```sh
cargo build --manifest-path packages/runtime-rust/Cargo.toml
packages/runtime-rust/target/debug/stella-runtime --database /tmp/stella-native/stella.sqlite
```

The default listener accepts the existing JSON-RPC envelope, one JSON object per
line. For example:

```json
{"jsonrpc":"2.0","id":1,"method":"internal.worker.storage.diagnostics","params":{}}
```

`--migrate --database PATH` opens and upgrades a database and prints diagnostics.
Use a backup of an existing installation when investigating migration behavior.

`--run --database PATH` accepts a single JSON request on stdin with `agentType`,
`prompt`, optional `model`, and optional `conversationId`. Set
`STELLA_AUTH_TOKEN` to a Convex JWT and `STELLA_MODEL_GATEWAY_URL` to the managed
gateway origin. This standalone entry point uses an ephemeral device signer;
the desktop integration must use its existing protected device identity instead.
It emits JSONL agent events and persists user and assistant chat entries.

## Executable verification

These scripts launch the real binary and use isolated SQLite files. They are
integration checks, not unit tests. The legacy comparison also runs the existing
Bun migration against a copy of the same input database.

```sh
python3 packages/runtime-rust/scripts/verify-storage.py
python3 packages/runtime-rust/scripts/verify-legacy-migration.py
python3 packages/runtime-rust/scripts/verify-live-agent.py
python3 packages/runtime-rust/scripts/verify-live-agent.py --rpc
python3 packages/runtime-rust/scripts/verify-live-agent.py --rpc --steer
python3 packages/runtime-rust/scripts/verify-live-agent.py --rpc --cloud
python3 packages/runtime-rust/scripts/verify-live-agent.py --rpc --catalog
python3 packages/runtime-rust/scripts/verify-live-agent.py --rpc --cancel-shell
python3 packages/runtime-rust/scripts/verify-live-agent.py --image
python3 packages/runtime-rust/scripts/verify-live-agent.py --patch
python3 packages/runtime-rust/scripts/verify-live-agent.py --shell
python3 packages/runtime-rust/scripts/verify-live-agent.py --pty
python3 packages/runtime-rust/scripts/verify-live-agent.py --shell-volume
python3 packages/runtime-rust/scripts/verify-rpc.py
bun packages/runtime-rust/scripts/verify-catalog.mjs
```

The live check mints a dev Pro test account using the existing Convex login or
`CONVEX_DEPLOY_KEY`. It makes real model requests, invokes the Rust file reader,
and checks the final answer against a nonce. Tokens stay in process memory.

## Remaining cutover work

The following are required before this can replace the old runtime:

- Full agent-loop parity: concurrent tools, inactivity/abandonment handling,
  suspension, retries, durable event replay/acknowledgment, compaction, steering,
  background agents, and cancellation settlement.
- The remaining native tool implementations and their platform integrations:
  shell/PTY sessions, code/browser/computer tooling, media, connector OAuth and
  MCP, scheduling, discovery, projects, workspace lifecycle, and voice.
- Provider parity, credential refresh and protected storage, model catalog and
  routing, multimodal/tool-result fidelity, usage/cost accounting, and native
  subscription-provider flows.
- Complete thread/session/search APIs and outbox delivery/control services.
  Existing outbox rows survive migration; transcript delivery is connected, while
  journal, agent, connector, voice and control delivery remain to be ported.
- Replace Electron's runtime-internal imports with an RPC client and preserve
  lifecycle attachment, host callbacks, packaging, and restart behavior.
- Replace the cloud-builder agent path with the Emscripten implementation,
  preserving existing DO identities, authorization, filesystem projection,
  alarms, continuation/recovery, and the chosen sandbox tier.
- Remove the TypeScript runtime/extension loader only after the above consumers
  have moved. The extension system has **not** been retired yet.
- Verify the switched desktop and cloud product flows end to end. A successful
  baseline run of the old desktop runtime is not evidence of a Rust cutover.
  Native desktop verification has completed a signed-in reply and a real Read
  tool call, with process identity and visible answers captured under the
  verify-stella artifacts directory. This is only the exercised execution path.
