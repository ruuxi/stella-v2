# Emscripten runtime target

This is a live-verified **target integration**, not a replacement for
`workers/cloud-builder`. It runs the shared Rust built-in agent catalog and
prompt policy inside an Emscripten Worker and a SQLite-backed Durable Object.
`/health` reports `agentExecutionReady: false` because the cloud agent loop and
tool services have not been connected.

The Rust source is pinned to workers-rs commit
`b57ba6ef8198c65499c2f92b1845cc2412dd6e8c`, with Rust `1.100.0-beta.1` and the
Cloudflare Tokio patches. Cargo lockfiles pin the remaining dependencies.
Generated JavaScript is Workers/Emscripten host glue, not an extension host or
JavaScript implementation of agent behavior.

```sh
cd workers/runtime-rust
node toolchain/build.mjs
bunx wrangler@4.143.0 dev --local
```

With the server running, `node toolchain/verify.mjs` performs real HTTP and DO
checks. Pass the deployed URL as its first argument to check the live Worker.

The build script installs a project-local, pinned `worker-build`. Its small
patch handles Cargo 1.100's changed location for wasm-bindgen inline snippets.
Without the patch, compilation succeeds but bundling fails on a missing
`snippets/.../inline0.js`. `STELLA_WORKER_BUILD` can point to an already-patched
binary. The first build downloads the Emscripten SDK and Rust tooling.

Define `RUNTIME_VERIFY_TOKEN` in an ignored `.dev.vars` for local execution, or
as a Worker secret for deployment. Authenticated routes require it as a bearer:

- `GET /agents`: compiled built-in definitions.
- `POST /prepare`: a `PromptContext` object and `x-stella-thread` header. The DO
  persists reminder gates in SQL, applies the Rust policy, and exercises an
  asynchronous Tokio timer.

The deployed verification target is
`https://stella-v2-runtime-rust-dev.fromyou.workers.dev`.
It does not alter production or existing cloud-builder bindings/DO namespaces.
