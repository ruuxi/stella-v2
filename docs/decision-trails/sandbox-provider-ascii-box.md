# Sandbox provider: Cloudflare Sandbox vs ascii.dev Box

Evaluation written 2026-09-02. Price is the deciding factor. The question was
whether `workers/cloud-builder` should move its sandbox compute from the
Cloudflare Sandbox SDK (Durable Object backed containers) to ascii.dev Box
(persistent Linux VMs behind a REST API). Read this before touching the
sandbox layer of `cloud-builder`; it records what the current code depends on,
what Box offers, where the two diverge, and the recommended migration shape.

Nothing has been implemented yet. This document is the handoff.

## Verdict

Yes on price, no as a drop-in. Box is roughly 3 to 11 times cheaper per
running hour than the instance types we use, has free stopped state and free
snapshots, and its VM model fits a persistent per-owner workspace better than
an ephemeral container does. But `cloud-builder` is written directly against
Cloudflare primitives (DO-colocated sandbox classes, sessions, background
processes, `static outbound` egress interception, `trycloudflare` tunnels), so
the change is a rearchitecture of the compute layer, not a provider swap.
There are no users yet ([no-users-greenfield-ok]), so the rework is cheapest
now.

## Price

Cloudflare bills memory and disk while provisioned and vCPU only while active
(Workers Paid rates: $0.0000025 per GiB-second, $0.000020 per vCPU-second,
$0.00000007 per GB-second of disk). Box bills a flat rate per second while a
box is running and nothing while it is stopped.

| Machine | vCPU / RAM / disk | $/hour idle CPU | $/hour full CPU |
|---|---|---|---|
| CF standard-4 (our agent + app-build) | 4 / 12 GiB / 20 GB | 0.113 | 0.401 |
| CF standard-2 (our small resident) | 1 / 6 GiB / 12 GB | 0.057 | 0.129 |
| Box small | 2 shared / 4 GB / 12 GB usable | 0.018 | 0.018 |
| Box default | 4 shared / 8 GB / 50 GB usable | 0.036 | 0.036 |
| Box large | 8 shared / 16 GB / 70 GB usable | 0.072 | 0.072 |

Box rate is $0.00001 per second for default; small is 0.5x, large is 2x.

Plans and limits:

| Plan | Machine hours included (default) | Concurrent boxes |
|---|---|---|
| $20/mo | ~555 | 100 |
| $100/mo | ~2,777 | 250 |
| $500/mo | ~13,888 | 1,000 |
| $2,000/mo | ~55,555 | 1,500 |

- The $20 floor means Cloudflare is cheaper below roughly 100 to 180 hours a
  month of standard-4 (depending on CPU load). Above that Box wins and the gap
  widens with load. Current usage is near zero, so the floor is a cost today.
- Stopped boxes cost nothing. Snapshots are free, incremental, taken every
  minute and on stop, retained indefinitely (latest per box, up to the
  type's usable disk).
- Egress included up to 2 TB per box per month. Cloudflare charges $0.025/GB
  past 1 TB.
- Trial: 7 days, 2 concurrent boxes, 25 machine hours, 2 hour max TTL, no
  large machines.
- Balance at zero gives a 24 hour grace period, then boxes are snapshotted and
  stopped.

## What the current code depends on

Only `workers/cloud-builder` uses the SDK (`@cloudflare/sandbox` 0.12.9,
pinned in `package.json` and asserted in `scripts/prepare-image.mjs` and the
Dockerfile). Everything below has to be remapped or removed.

Handle and lifecycle:
- `getSandbox(ns, id, { transport: "rpc", keepAlive: true, ... })` in
  `BuildSession.sandbox()` (`src/index.ts` ~5377-5390). Three DO namespaces:
  `Sandbox` (standard-4, agent), `SANDBOX_SMALL` (standard-2, resident
  attachment), `APP_BUILD_SANDBOX` (standard-4, app build). Classes exported
  at `src/index.ts` ~395-408, defined in `src/sandbox-egress-classes.ts`.
- IDs are per turn attempt: `sandboxLifecycleId(prefix, {ownerId,
  ownerGeneration, turnId, attemptGeneration})` in `src/sandbox-lifecycle.ts`.
  Not kept warm across turns. State survives via R2, not a live container.
- Teardown is durable-debt based (`destroySandboxDurably`, `SandboxDestroyDebt`
  plus DO alarm, backoff 1s to 15m). `setKeepAlive(false)` then `destroy()`.
- Instance size is chosen by `initialInstanceSize()` and remembered per
  workspace in KV `APP_ROUTES`; OOM escalates to a new sandbox id
  (`SandboxOutOfMemoryError`, `src/agent-compute-ladder.ts`).

Sessions and processes (no Box equivalent):
- `createSession` / `deleteSession` (index.ts, `src/turn-state-checkpoint.ts`).
- `session.exec` everywhere; `startProcess`, `getProcess`, `waitForPort(5173)`,
  `killProcess(pid, "SIGKILL")`, `killAllProcesses(sessionId)`.
- `src/strict-session-process.ts` wraps exec/startProcess in a
  `setpriv --reuid=42424` privilege drop; nothing runs model-controlled
  commands as root.

Files:
- `readFile` (base64), `writeFile` (including streaming an R2 body straight
  into the container), `deleteFile`, `mkdir` across index.ts,
  `src/agent-sandbox-attachment.ts`, `src/cloud-skill-materializer.ts`,
  `src/turn-state-archive.ts`.

Ports:
- `sandbox.tunnels.get(5173)` only (index.ts ~11941). The trycloudflare URL is
  held in DO storage and fronted by an HMAC capability proxy
  (`src/vite-preview-access.ts`). No `exposePort` anywhere.

Persistence:
- No `createBackup`. Snapshots are hand-rolled squashfs archives made by
  in-container `mksquashfs` and streamed to R2 `BACKUP_BUCKET`
  (`src/turn-state-archive.ts`, `src/native-state-checkpoint.ts`).
  `restoreBackup` is used on a legacy path only.

Egress control (Cloudflare-only):
- `GeneralAgentSandbox { enableInternet = true }` and
  `AppBuildSandbox { enableInternet = false; allowedHosts = ["*"] }` with
  `static outbound` handlers (`src/sandbox-egress-classes.ts`, policy in
  `src/sandbox-egress-policy.ts`). App-build sandboxes deny all HTTP(S) and
  emit destination-only telemetry; agent sandboxes allow and log.

Image:
- `workers/cloud-builder/Dockerfile`: `FROM cloudflare/sandbox:0.12.9`, a
  digest-pinned `oven/bun:1.4.0` layer, poppler-utils, mediainfo, libicu70,
  fonts, util-linux, squashfs-tools, baked `.image/` packages with a frozen
  lockfile, the `stella-tools` uid/gid 42424 identity, and permission fences
  on `/workspace`, `/home/stella-native-state`, `/home/stella-host-state`.

Abstraction that exists:
- `SandboxAttachment` port (`boot` / `callTool` / `control` / `destroy`) in
  `src/agent-compute-ladder.ts` ~192-210, implemented by
  `createAgentSandboxAttachment` in `src/agent-sandbox-attachment.ts`. This is
  the natural provider seam for the agent path.
- The app-build path is direct: `BuildSession.sandbox()` handles used inline
  throughout `src/index.ts`. No seam.
- About fifteen test files `mock.module("@cloudflare/sandbox", ...)` and two
  workerd fixtures under `tests/fixtures/` exercise the real classes.

Other Cloudflare coupling that stays regardless: R2 (`BACKUP_BUCKET`,
`APP_BUILDS`, `AGENT_HOME`, `CONVERSATION_ARCHIVE`), the owner fence
(`src/owner-fence-do.ts`, sweeps R2 on purge, gates world leases), KV, Queues,
service bindings to `MODEL_GATEWAY` / `BROWSER_GATEWAY` / `TELEMETRY`. The
container reaches the Workers over public HTTPS with signed turn capabilities
(`MODEL_GATEWAY_URL`, `CLOUD_BUILDER_PUBLIC_URL`), which works from any host.

## What Box offers

Product facts, from docs.ascii.dev and box.ascii.dev as of 2026-09-02.

- Full Ubuntu VMs with sudo, Docker inside, dedicated IPv4 or IPv6, up to 50
  hosted ports, optional 60fps desktop. Shared vCPUs tuned for spiky IO-heavy
  work, not sustained compute.
- Regions: EU only (Germany, Finland, France) on OVH and Hetzner hardware.
  Round trips from the US are 100 to 200 ms.
- Base URL `https://ascii.dev/api/box/v1`, bearer API key. TypeScript SDK
  `@asciidev/box-sdk` (generated OpenAPI client, Node 18+ fetch, ESM and CJS;
  should run in Workers since it is fetch based, unverified). Python SDK and
  CLI exist.
- Lifecycle: `POST /boxes` (fields `type`, `ttlSeconds` 1..2,592,000 or null,
  `env` up to 100 vars / 64 KB, `noEnv`, `environment`, `setupScript` up to
  64 KB, `from` named snapshot, `org`; `Idempotency-Key` header kept 24 h),
  `stop` (snapshot then archive, free), `resume` (same id, fresh hardware,
  usable in a few seconds, can change `type`), `fork` (new id from latest
  snapshot, idempotent, defaults to 1 h TTL), `DELETE` (needs
  `X-Ascii-Confirm-Delete`, not instant). States: provisioning, ready, idle,
  running, archived, error. Commands before `ready` fail with retryable 409.
- Default TTL is 1 hour counted from creation, not last activity. `ttlSeconds:
  null` disables auto-stop (paid accounts only). Extendable up to 30 days.
- Commands: `POST /boxes/{id}/commands`, synchronous with a 1 to 600 second
  timeout (default 30), or detached with a process id and a status endpoint
  that returns running / exitCode / log tail. Logs at
  `~/.ascii/processes/<pid>.log`. Detached processes do not survive stop,
  resume, or fork; systemd units do and restart on resume/fork. No streaming
  stdout on the commands API.
- Files: `GET`/`PUT /boxes/{id}/files`, UTF-8 or base64, paths under
  `/home/user` or `/tmp`. Snapshot tree and file download work while archived.
- Hosting: `box host <port> --private|--public` gives
  `https://<box-subdomain>-<port>.on.ascii.dev`, private by default with a
  `?_token=` query parameter (sticky per port). Service must bind `0.0.0.0`.
  Ascii terminates TLS and proxies to the box.
- Snapshots: incremental, deduplicated, every minute plus on stop. Named
  templates survive deletion of their source box and deploy in a few seconds
  at roughly constant cost. Docker build caches are excluded.
- Webhooks: account-wide, up to 10 HTTPS endpoints. Events `box.ready`,
  `box.hydrated`, `box.error`, `box.archived`. HMAC-SHA256 over
  `delivery_id.timestamp.raw_body` in `X-Ascii-Signature` (`v1=`), at least
  once delivery, 8 retries with backoff, 30 day history.
- Rate limits: create, fork and resume each count as one machine start
  against a per-minute rate (number not published; `GET /limits` returns it),
  5x per hour, 3x hourly per day. `rate_limited` and `limit_reached`
  (concurrency) error codes.
- Multi-tenant: create end-user boxes with `noEnv: true` or mark the
  environment "safe for third parties", otherwise the box inherits account
  secrets and GitHub tokens. Tag boxes via `env`. Orgs exist for billing.
- No custom images. Customize with `setupScript`, repo setup scripts, or a
  template snapshot plus `from`.
- Zero data retention is an account toggle (browser sign-in only). After
  deletion they keep machine assignment, IP/MAC attribution, audit and
  billing records only.
- Also ships a built-in `prompt` endpoint that runs Claude Code or Codex
  inside the box. Not relevant; we run our own agent.

Company and terms:
- Legal entity Dedale AI, Corp., Delaware. Small team (two founders visible).
  Claims over 10 million VM-seconds per day in production.
- No SLA. Liability capped at the greater of $100 or three months of fees.
  Service "as is", no uptime, security or data-loss guarantee. May suspend or
  delete accounts with or without notice for abuse.
- No SOC 2 or similar claims found. Comparison page is marked work in
  progress.

## Gap analysis

| Current dependency | Box equivalent | Notes |
|---|---|---|
| DO-colocated sandbox class, RPC handle | Remote REST client | Every exec/read pays an EU round trip (100-200 ms from US). |
| `createSession` / `deleteSession` | none | Drop sessions; use a single box or an in-box daemon. |
| `exec` with streaming output | sync command (600 s cap) or detach + poll | No stdout streaming. Run our own HTTP daemon in the box for tool calls. |
| `startProcess` / `waitForPort` / `killProcess` | detach + status, or systemd unit | Vite dev server should be a systemd unit so it survives resume. |
| `readFile` / `writeFile` / `mkdir` / `deleteFile` | files API (under `/home/user` or `/tmp`) or daemon | Streaming R2 body into container needs the daemon or a URL fetch from inside. |
| `tunnels.get(5173)` | host port private, `on.ascii.dev` URL with `_token` | Keep `vite-preview-access.ts` proxy in front; never hand the token to clients. |
| `static outbound` egress deny + telemetry | none | Enforce with nftables as root inside the VM; tool user is uid 42424 without sudo. Destination telemetry needs a local proxy. |
| Dockerfile image | template snapshot + `from`, or `setupScript` | Rebuild the image contents as a template box build script. |
| squashfs to R2 checkpoints | native stop/resume snapshots | Could delete most of `turn-state-archive.ts` / `native-state-checkpoint.ts`; keep R2 archive as portable source of truth. |
| Per-turn sandbox id, destroy after turn | one box per owner, stop when idle, resume on turn | Fits start rate limits and free stopped state. Resume counts as a start. |
| standard-4 12 GiB | default 8 GB, large 16 GB | OOM ladder needs a third rung. |
| standard-2 for resident attachment | small 4 GB | |
| `SandboxDestroyDebt` alarm | same pattern with `Idempotency-Key` on create/fork and confirm header on delete | |
| Fifteen test mocks of `@cloudflare/sandbox` | new provider mock | |

## Recommended migration shape

1. Put a provider boundary at the `SandboxAttachment` seam first and extend it
   to cover the app-build path, so `src/index.ts` stops calling sandbox
   handles inline. Keep the Cloudflare implementation working behind it.
2. Prototype on the trial: one owner-scoped box created with `noEnv: true`,
   a small HTTP daemon inside it (systemd unit, hosted private) that
   implements boot / callTool / control, and measure create-to-ready,
   resume-to-ready, fork time, and the actual machine-start per-minute limit
   from `GET /limits`. These numbers are not published and decide whether
   per-owner resume-on-demand is viable.
3. Build the image as a template box: run the Dockerfile's contents as a
   setup script on a fresh box (bun, squashfs-tools if still needed, uid
   42424 fences, `.image/` packages), stop it, name the snapshot, create all
   user boxes with `from`.
4. Reimplement the app-build egress deny with nftables at template build
   time. Decide whether destination telemetry is worth a local proxy.
5. Move preview URLs to hosted private ports behind the existing HMAC proxy.
6. Switch lifecycle to per-owner boxes: create on first turn, `stop` on idle
   (replaces `SANDBOX_IDLE_TIMEOUT_MS`), `resume` on next turn, `DELETE` only
   on owner purge from the owner fence. Set `ttlSeconds` as a safety net
   rather than relying on it.
7. Keep R2 turn-state archives until the Box snapshot path has run for a
   while; they are the exit hatch if the vendor disappears.
8. Replace the test mocks and the two workerd fixtures with a provider mock.

Open questions to settle during the prototype:
- Real create/resume/fork latency and the start rate limit.
- Whether `@asciidev/box-sdk` runs inside a Worker or whether to call the
  REST API with plain fetch.
- Whether the in-box daemon should own file transfer to R2 directly
  (presigned URLs) instead of proxying bytes through the Worker.
- EU-only placement versus where users are; the compute is fine there, but
  per-call latency argues for fewer, batched calls.
- Whether to keep Cloudflare for app-build (egress deny, tunnels) and move
  only the agent path, accepting two providers.

## Sources

- https://box.ascii.dev/ and https://box.ascii.dev/compare
- https://docs.ascii.dev/box/billing.md, /box/machines.md, /box/faq.md
- https://docs.ascii.dev/box/platform-guide, /box/long-running-tasks.md
- https://docs.ascii.dev/box/api/v1 and /box/api/reference/boxes/create-box.md
- https://docs.ascii.dev/box/sdks/typescript, /box/hosting.md,
  /box/snapshots.md, /box/webhooks.md, /box/cli-reference.md
- https://box.ascii.dev/terms
- https://developers.cloudflare.com/containers/pricing/
- https://developers.cloudflare.com/containers/platform-details/limits/
- https://developers.cloudflare.com/sandbox/concepts/sandboxes/
