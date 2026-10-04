# Runtime worker perf lab

Deterministic lab measurements for the runtime worker (the detached Bun
process that runs agent turns). The approach: pick the few journeys that
matter, give each deterministic start/end marks, pair every wall-clock number
with proxy metrics that do not depend on machine noise (statement counts,
module bytes, JSON-RPC lines/bytes), check that the proxies move with
wall-clock, and ratchet both in CI.

```sh
bun packages/runtime/scripts/perf/bench.mjs all   --lab-dir /tmp/stella-perf-lab --out report.json
bun packages/runtime/scripts/perf/bench.mjs check --lab-dir /tmp/stella-perf-lab     # local gate
bun run runtime:perf:check                                                         # CI gate (check --counts-only --sizes 1000)
bun packages/runtime/scripts/perf/bench.mjs boot  --entry source --cache warm --repeat 10 --json
bun packages/runtime/scripts/perf/bench.mjs help
```

`--lab-dir` defaults to `$STELLA_PERF_LAB_DIR` or `$TMPDIR/stella-perf-lab`.
Seeded data-dir templates are cached there (`templates/`; the 100k-event one
is ~80 MB and takes ~70 s to seed); `--reseed` rebuilds them. Per-run copies
under `runs/` are deleted at exit unless `--keep-runs`. Reports record the git
HEAD and the number of uncommitted files under `packages/runtime` and
`packages/contracts` (`machine.dirtyRuntimeFiles`): a baseline taken on a dirty
tree measures that tree. Each command prints its tracked metrics; `--json` prints the full report
(per-journey breakdowns, top SQL statements, module census, per-method RPC
bytes).

## Isolation and determinism

Every worker the bench spawns gets:

- a scratch `HOME`, `STELLA_DATA_DIR`, `STELLA_RUNTIME_STATE_DIR`, `TMPDIR`
  and `BUN_RUNTIME_TRANSPILER_CACHE_PATH` under `--lab-dir`, and an
  allowlisted environment (PATH, LANG, USER plus the above). No inherited API
  keys, no inherited `STELLA_*`. Nothing touches `~/.stella`.
- `--preload probe-preload.ts` (loaded only by this bench; no production module
  imports it):
  - **Network guard.** `fetch` never leaves the machine. The pi.dev model
    catalog refresh gets a 404 (the runtime records an empty refresh and
    moves on); anything else throws and is counted (`fetch.blocked`).
  - **Scripted fake provider** (`STELLA_PERF_FAKE_PROVIDER=1`, source entry
    only). Registers api `perf-scripted`. The bench writes a `models.json`
    provider `perf` / model `scripted` and pins `orchestrator`, `general`
    and `explore` to `perf/scripted` in `preferences.json`. Replies are
    synchronous and instant, so a turn's wall-clock is pure runtime overhead.
    A prompt containing `[perf:tool]` gets one tool call
    (`STELLA_PERF_FAKE_TOOL`, default `Read` of a 3-line fixture), then
    `done`.
  - **Counters**: every bun:sqlite statement (count, time, rows, per SQL
    shape and database file; `prepare` count and time), stdout JSON-RPC
    lines/bytes per method. `STELLA_PERF_SQL_COUNTERS=0` disables the SQL
    wrapper (profile runs).
  - **Snapshots** on `SIGUSR2`: one `@@PERF {json}` line on stderr, taken
    after a full GC. The bench diffs consecutive snapshots.
  - **Module census** (`STELLA_PERF_MODULE_CENSUS=1`, untimed runs only).
  - The scratch `HOME` also isolates `~/.stella-browser` (the worker writes
    the `stella-app-bridge` extension token there at boot); a bench worker
    never touches the real browser-bridge session.
- A copy of a seeded "returning user" data dir (schema migrated, catalog
  refresh stamped, one prior conversation). Every copy restamps the catalog
  store's `checkedAt` to now: templates are cached across invocations and the
  runtime refetches every provider once those stamps pass its 4 h refresh
  interval, so a template's age would otherwise decide the boot counts.

The host side is a minimal in-process JSON-RPC host inside `bench.mjs`
(device identity, empty LLM credentials, unauthenticated auth refresh), so
marks are taken on raw worker messages with no `StellaRuntimeHost` in
between.

## Journeys

### J1 worker cold start (`boot`)

Spawn `bun <entry>` in stdio mode, write a probe request immediately, then
`internal.worker.initialize`, then poll `internal.worker.health` every 5ms.

| Mark | Meaning |
| --- | --- |
| `spawnToTransportMs` | spawn → first response. Over stdio the peer only attaches after the entry graph is evaluated and `main()` reaches `startWorkerTransport`, so this is "process up + module graph + main prelude". (`internal.worker.readyz` is answered pre-attach only by the socket transport; over stdio it returns METHOD_NOT_FOUND, which is the cheap round trip we want.) |
| `initializeRttMs` | `internal.worker.initialize` round trip (session graph, SQLite open/migrate, lazy runner import) |
| `initializedToReadyMs` | initialize → `health.ready` (runner init: extensions, models.json, catalog). This is what the host's `runtime-ready` waits on. |
| `spawnToReadyMs` | headline |
| breakdown | `execToProcessStartMs` (spawn → worker `performance.timeOrigin`), `processStartToPreloadMs`, `preloadMs`, `entryGraphToTransportMs` |

Configurations: `--entry source` (`packages/runtime/worker/entry.ts`) and
`--entry bundle` (`packages/desktop/dist-electron/runtime/worker/entry.js`,
run with `STELLA_APP_RESOURCES_PATH` pointed at `dist-electron` so assets
resolve as in a packaged app; the app runs the worker from source and no
longer builds this bundle, so it is skipped when absent), each with
`--cache warm` (shared transpiler cache, primed by a discarded run) and
`--cache cold` (fresh empty cache dir per run). The OS page cache is always
warm; true first-launch-after-install is not simulated.

Proxies: **module census** — modules and bytes loaded per phase (before
transport / before initialize returned / before ready / during the first two
turns). The census plugin intercepts TypeScript sources and bundle chunks
only (plugin-loaded `.js` would lose Bun's CommonJS detection) and expands
each observed module to its static import closure from an esbuild metafile of
the source graph, so node_modules JS is counted too. Also boot SQL statements.
Use `profile` for per-module CPU.

Proxies: **boot JSON-RPC** (`bootRpc`), counted bench side in stdout order
from spawn to the first health response that reports ready. The responses to
the bench's own probes (`readyz`, the 5ms `health` polls, whose count depends
on timing) are excluded; what remains (initialize response, notifications,
worker→host requests) is identical on every run of a tree. Gated per boot
config: `linesOut`, `bytesOut`, `notificationsTotal`,
`notifications.<method>` (`modelCatalog.updated` is always reported, 0 when
absent), `hostRequests` and `hostRequests.<method>` (`host.*` requests the
worker makes during boot), plus `postReadyLinesOut`/`postReadyBytesOut` for the
first 250ms of stdout silence after ready, so work moved just past ready does
not escape. Bytes are counted with the lab dir, repo path and per-run dir
replaced by fixed tokens, so a different checkout or temp path does not move
them. `fetch.blocked` / `fetch.catalogRequests` count fetches during boot
(both 0 on a seeded data dir). Each boot config's counts are the max over the
runs; `bootRpc.<window>.nondeterministic` lists any field that differed
between runs, and `check` fails if it is non-empty.

### J2 chat-turn overhead (`turn`, plain)

`internal.worker.startChat` on a local conversation; marks from the worker's
own `run.event` notifications: send → ack (startChat response) →
`run-started` → first `assistant-message` → `run-finished` → `toIdleMs`.
There is no per-token STREAM event any more: `assistant-message` is the only
assistant-text carrier, so "first assistant-message" is the first-text mark.
`toIdleMs` is a health RPC written the instant `run-finished` arrives; it is
answered only when synchronous post-turn work yields the event loop.

The first turn after boot is reported separately (`firstTurn`: lazy imports,
cold statement paths). Then `--warmup` turns, then `--repeat` timed turns
back to back with one snapshot before and after the window (per-turn
snapshots force a GC and flatter latency by ~2-3x; `--gc-each-turn` exists to
show exactly that). Counters are per-turn means over the window.

Proxies: SQL statements (and writes, commits, rows, prepares), JSON-RPC lines
and bytes out (per method), host round trips, retained heap per turn.

### J3 tool-call overhead (`turn`, tool)

Same as J2 with `[perf:tool]`: model call → `Read` tool → model call → text.
`nonToolMs = toRunFinishedMs − (tool-end − tool-start)`.

### J4 history read (`history`)

A conversation seeded with N = 1k / 10k / 100k `user_message` /
`assistant_message` events through `internal.worker.localChat.appendEvent`
(the worker's own append path, so schema/indexes/triggers are realistic;
seeding cost is itself reported as append ms/statements per event). Then
`internal.worker.localChat.listEvents` (default window) and `getEventCount`,
`--repeat` calls each (first call separate), with statements/rows per call.
Also runs 5 turns on that conversation to show whether history size leaks
into turn cost, and records boot-to-ready on the large DB.

`--history-shape modern` seeds a different template: one real turn first,
then the N events after it, so the durable thread is the model history and
the events only feed reminders and locale (a conversation that started after
the durable-store transition). The default `legacy` shape has every event
predate the thread, so the pre-transition shim projects up to 800 of them
into every prompt; `check` uses the default.

### J5 persistence write (derived, in `turn`)

From J2's window: write statements, commits, SQL ms and RPC bytes per turn,
and per persisted-row fan-out notification (`localChat.updated` +
`localChat.threadActivityUpdated`). History seeding adds per-append cost.

### J6 memory (`memory`)

RSS / JSC heap / object count (after full GC) after boot, after 10 and after
100 turns (every 5th a tool turn) in one conversation, plus `ps` RSS without
GC. Reports growth per turn between the last two checkpoints.

### J7 bundle (`bundle`)

Sizes of `dist-electron/runtime/**` by directory and largest files, and a
fresh esbuild build (write:false) with the code-split worker options in
`cmdBundle` to get a metafile: output
bytes, bytes statically reachable from `entry.js` (parsed at boot), and the
top 30 dependencies by bytes overall and in boot chunks. The metafile is
written to `<lab-dir>/bundle-metafile.json` (load it in esbuild's analyzer).

### Profiles (`profile`)

`bun --cpu-prof` for boot (source + bundle, exit right after ready) and for
boot + N turns. Aggregates self time by function, module and package. Per-turn
figures are `(boot+N turns − boot-only) / N` (inferred by subtraction). JSC
emits no idle samples, so each sample's weight is clamped to 3 sampling
intervals to keep idle gaps from being billed to the last frame. The SQL
wrapper is disabled in profile runs. Raw `.cpuprofile` files are kept under
`<lab-dir>/profiles/` (open in Chrome DevTools / speedscope).

### Validation (`validate`)

For each proxy, correlation (Pearson and Spearman) with wall-clock across
configurations: boot module bytes vs spawn→phase time (source/bundle × warm/
cold × transport/ready); turn SQL statements and RPC bytes vs turn time
(plain, tool, turns on 1k and 10k histories).

## Baseline and ratchet

`baseline.json` holds this machine's numbers and a **ceiling** per metric:
`value × (1 + rel) + abs` by kind (`bench.mjs` → `TOLERANCE`):

| kind | rel | abs | used for |
| --- | --- | --- | --- |
| time | 35% | 3 ms | wall-clock |
| count | 5% | 2 | statements, RPC lines, modules |
| exact | 0 | 0 | boot notifications, boot host requests, boot fetches |
| bytes | 5% | 1 KB | RPC bytes, bundle/module bytes |
| mem | 20% | 2 (MB/KB) | RSS, heap |

- `check` runs the CI subset (boot source/warm + census, turn, history
  1k/10k, bundle) and exits 1 when any count/bytes/mem metric exceeds its
  ceiling. Wall-clock (`time`) regressions print `warn` unless
  `--strict-time` is passed (use it only on the machine class that recorded
  the baseline, on a quiet host: on a shared dev machine the same turn
  measured 9 ms and 16 ms p50 an hour apart).
- `check --counts-only` gates only `count`, `exact` and `bytes`; wall-clock and
  memory print `warn` on any runner. This is the CI mode: the `runtime` job in
  `.github/workflows/ci.yml` runs `bun run runtime:perf:check` (source entry,
  warm cache, 1k history template only; ~20 s including seeding, no bundle
  build) with `STELLA_PERF_LAB_DIR` under the runner temp and uploads the JSON
  report as the `runtime-perf-report` artifact. It needs no secrets and no
  network: the fake provider serves every model call, and the network guard
  answers the pi.dev catalog refresh a fresh seed triggers with a local 404
  (the seed logs how many it answered) and blocks any other fetch.
- `check --ratchet` lowers every ceiling this run beat (never raises).
- `--add-missing` (any command) adds the metrics this run measured that
  `baseline.json` lacks, with fresh ceilings, and never touches an existing
  entry. Use it to introduce a new metric without re-recording the others.
- `all --write-baseline` rewrites the baseline from scratch; do it on the CI
  machine class, not a laptop, before wiring `check` into CI.
- To lower a ceiling by hand after an optimization lands, edit `ceiling` in
  `baseline.json` (or run `check --ratchet`) in the same PR. Raising one needs
  a written reason in the PR.

Counts and bytes are the gate you can trust across machines; wall-clock
ceilings are only meaningful on the machine class that recorded them.

## Files

- `bench.mjs` — harness, journeys, reporting, baseline/check.
- `probe-preload.ts` — network guard, fake provider, counters, census.
- `baseline.json` — recorded baseline and ceilings.
