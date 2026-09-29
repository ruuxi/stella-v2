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
- Signed-in desktop cloud turn admission/renewal/finish through the existing
  Durable Object, with a native transcript outbox and interrupted-begin recovery.
  Other outbox families and full recovery parity remain below.
- Compiled Rust agent metadata and prompt-reminder policy in `../runtime-core`.
- A standalone Rust agent loop and managed model-gateway execution using
  Ed25519 capability exchange, DPoP, descriptor revisions, and the Responses and
  Chat Completions protocols. The current standalone tool adapter implements
  bounded UTF-8 `Read` only. It is not the complete Stella tool pack.

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
python3 packages/runtime-rust/scripts/verify-rpc.py
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
