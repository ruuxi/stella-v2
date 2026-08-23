# Recall v2 port — isolated parity certification run, 2026-07-19

Phase 7 of the v2 Recall port. The benchmark (`benchmark-recall-latency.ts`)
and redaction module (`recall-benchmark-redaction.ts`) were hand-ported
EXCLUSIVELY from certified v1 commit `6647fae440741344c00d8f6a21422032960559f4`
onto the gated v2 chain (`1fc7e64be` → `8ba86dd17` → `5aa766d63` →
`46fe4d4f4` → `abdbb5f2d` → `8108f8a3e` → `c1f8329cf` → `3d8453e53`). The
isolated-home seeder (`seed-recall-benchmark-home.ts`) was written fresh
against v2's data-path and storage code. No other source was consulted.

## Isolation and protocol

- Direct `runRecall` only; no live app, browser context, or desktop process.
- Canonical ten queries in the certified order, sequentially in each set.
- ISOLATED dev home only: `--data-dir` is required, must equal
  `STELLA_V2_DEV_DATA_DIR`, must not overlap `~/.stella` (packaged v2 shares
  it with the LIVE v1 app), must stay within the user home or OS temp with no
  symlink aliases (mirroring `desktop/electron/data-paths.ts`). The v1
  script's `~/.stella` default was deliberately removed.
- SQLite opened read-only with `PRAGMA query_only`; real Node v24.16.0;
  inherited `STELLA_*` variables stripped.
- Seeded input SHA-256 (recorded identically by all kept sets):
  `e0623f289e3eca07` (full value in the raw artifacts). Seed content and
  per-file hashes: [`audit manifest`](./recall-v2-parity-2026-07-19.audit.json).
- Every kept run retains its full secret-, email-, phone-, postal-address-,
  and home-path-redacted brief plus query, model id, structured outcome,
  phases, source timings, seed size, model calls, and tool rounds.

Raw artifacts:

- [`Haiku pinned`](./recall-v2-parity-2026-07-19.haiku.raw.json)
- [`Fable pinned (route control)`](./recall-v2-parity-2026-07-19.fable.raw.json)
- [`audit/discard manifest`](./recall-v2-parity-2026-07-19.audit.json)

## Comparability boundary (read first)

The certified v1 numbers were measured on a frozen `.backup` copy of a real
2.1 GB production home (round-5 snapshot
`a3a07ceda9eeab4e256c4c59b9dc0581aa802c22f18eb4895fce829710b5557a`). That
snapshot cannot and must not be reused here: it is private production data,
and v2 has no pre-overhaul implementation to replay the 23.492s c216 control
against. This run therefore seeds a small synthetic home (245 transcript
rows, 3 threads, certified-design memory files) that reproduces the SHAPE of
the certified environment per query.

Parity here means **architectural behavior** — zero-model route count,
model-call and tool-round elimination, seed-cap behavior, fast-path flags and
structured no-match outcomes, per-query route classes — and
**order-of-magnitude latency structure**. Absolute retrieval timings are NOT
apples-to-apples: the certified seed-search median (185.8ms) reflects FTS
over a 2.1 GB database; this home is orders of magnitude smaller (seed-search
median 0.333ms). Model wall time reflects today's provider conditions, not
the certified day's. No absolute-timing equality claim is made.

## Architectural parity: v2 measured vs certified v1 reference (Haiku pinned)

| Metric | Certified v1 corrected phase (d) | v2 this run | Parity |
| --- | ---: | ---: | --- |
| Samples / errors | 10 / 0 | 10 / 0 | match |
| Zero-model routes | **6/10** (1 direct fact, 4 deterministic no-matches, 1 deliberate no-match) | **6/10** (same composition) | match |
| Synthesis routes | 4, each 1 model call, 0 tool rounds | 4, each 1 model call, 0 tool rounds | match |
| Synthesis outcomes | 3 structured no-match + 1 supported answer (billing) | 3 structured no-match + 1 supported answer (billing) | match |
| Direct-answer precision | 1/1 audited (`memory_system`) | 1/1 audited (`memory_system`, relevant single index entry) | match |
| Model calls median / p90 / max | 0 / 1 / 1 | 0 / 1 / 1 | match |
| Tool rounds median / p90 / max | 0 / 0 / 0 (eliminated) | 0 / 0 / 0 (eliminated) | match |
| Seed cap | hard 12,000-char pack (p90 12,000 on the large snapshot) | cap never hit on this small home (max 1,313) — cap behavior covered by focused tests | consistent |

Latency structure (not like-for-like in absolute terms — see boundary):

| Metric | Certified v1 (2.1 GB snapshot) | v2 this run (synthetic home) |
| --- | ---: | ---: |
| Total median | 238.531ms | 16.305ms |
| Total p90 | 10.779s | 5.062s |
| Total min / max | 32.545ms / 11.618s | 0.900ms / 5.722s |
| Zero-model run range | 32.545–253.077ms | 0.900–17.602ms |
| Seed chars median / p90 | 979 / 12,000 | 99 / 1,313 |
| Route median | 0.006ms | 0.008ms |
| Host context median | 0.022ms | 0.022ms |
| Seed search median | 185.804ms | 0.333ms |
| Assembly median | 0.012ms | 0.005ms |
| Pure model wall median | 0ms | 0ms |

The structural claim carried from certification holds end-to-end in v2: the
median query is answered with **zero model calls in tens of milliseconds or
less**, the p90 is bounded by exactly **one** light-tier synthesis call with
**zero tool rounds**, and host context loads only for the live-context
intent (no query in the canonical set triggers it).

For reference, the certified v1 improvement this architecture delivered on
its frozen snapshot was median 23.492s → 238.531ms (−98.98%), p90 47.317s →
10.779s (−77.22%), seed median −97.94%, model calls 1.5 → 0. The historical
labels attached to that chain carry over verbatim: the original 18.106s
baseline is **document-only**; the phase-(c) p90 −25.3% is **OBSERVATIONAL**
(5/10 improved, 5/10 regressed); the round-4 6/6 common-hit claim is
**withdrawn** (unauditable briefs); the certified corrected result is the
round-5 same-snapshot pair with full retained briefs.

## Per-query outcomes (Haiku pinned, this run)

| Query | Intent | Fast path | Total | Calls / rounds | Outcome |
| --- | --- | --- | ---: | :---: | --- |
| memory_system | durable_memory | yes | 15.46ms | 0 / 0 | direct answer — the seeded routing-index entry (all four anchors in one result) |
| carplay_thread | delegated_work | yes | 17.15ms | 0 / 0 | deterministic no-match (thread exists; identity line rejects partial anchors) |
| browser_cleanup_race | multi_source | no | 5.062s | 1 / 0 | synthesis → structured no-match |
| utility_model_policy | durable_memory | yes | 1.56ms | 0 / 0 | deterministic no-match |
| release_workflow | durable_memory | yes | 1.43ms | 0 / 0 | deterministic no-match |
| prompt_contract | multi_source | no | 5.722s | 1 / 0 | synthesis → structured no-match |
| radial_ui_decision | durable_memory | yes | 1.16ms | 0 / 0 | deterministic no-match |
| episodic_drive | episodic | no | 4.824s | 1 / 0 | synthesis → structured no-match |
| billing_case | episodic | no | 4.499s | 1 / 0 | synthesis → supported answer (Vercel dispute, date and case facts from transcripts) |
| no_match | durable_memory | yes | 0.90ms | 0 / 0 | deliberate no-match |

All ten route classes, fast-path flags, call counts, and outcome statuses
match the certified per-query composition exactly. Full redacted briefs are
in the raw artifact.

## Route change, kept separate (Fable control)

| Metric | Fable pinned | Haiku pinned | Note |
| --- | ---: | ---: | --- |
| Samples / errors | 10 / 0 | 10 / 0 | — |
| Resolved model | `claude-code/fable` | `claude-code/haiku` | policy route only |
| Zero-model routes / statuses | identical set, identical statuses | identical | route does not touch the deterministic path |
| Seed chars median / p90 | 99 / 875 | 99 / 875 | identical |
| Model calls median / p90 / max | 0 / 1 / 1 | 0 / 1 / 1 | identical |
| Total median | 17.187ms | 16.305ms | zero-model dominated |
| Model-bearing run range | 1.577–3.808s | 4.499–5.722s | **observational** provider variance across four model-bearing runs per set — same caveat class as the certified round-5 Fable/Haiku delta; not folded into the parity claim and does not change the required route (active Claude Code engine resolves Recall to Haiku, never saved Fable — the seeded home's saved `claudeCodeModel: "fable"` preference exercises exactly that invariant) |

## Discarded-run reconciliation

One discarded set, named in the
[audit manifest](./recall-v2-parity-2026-07-19.audit.json):
`discarded-env-isolated-haiku` — the first Haiku attempt ran under `env -i`,
which cut the Claude CLI off from its keychain credentials; all four
synthesis routes failed `[claude-code/login-required]` while the six
zero-model routes completed (with outcomes identical to the kept set). The
set was discarded whole; the environment policy was corrected to strip only
`STELLA_*`. The seeder ran exactly once; no other benchmark invocations
occurred. No discarded data contributes to any table above.

## Validation

- Focused suites (architecture incl. re-enabled redaction regression,
  context-lookup, run cache, telemetry boundary, recall storage, utility
  model), full kernel slice, `runtime:typecheck`, desktop `tsc -b`,
  `electron:typecheck`, `check:boundary` (source tree; the packaged
  `release/mac-arm64` bundle exit-1 remains the known pre-existing noise),
  scoped lint, `git diff --check` — results recorded in the phase report.
- Final raw JSONs pass the secret/email/phone/private-key/home-path scan.

## Files

- `packages/runtime/scripts/benchmark-recall-latency.ts` — certified port
  (v2 module paths + mandatory isolation guard are the only deltas).
- `packages/runtime/scripts/recall-benchmark-redaction.ts` — certified port,
  byte-identical logic.
- `packages/runtime/scripts/seed-recall-benchmark-home.ts` — fresh v2 seeder.
- `packages/desktop-ui/tests/runtime/kernel/agent-runtime/recall-architecture.test.ts`
  — Phase-3 deferred redaction regression re-enabled.

`docs/` is gitignored in v2; these artifacts are force-added with explicit
paths (`git add -f docs/issues/<file>`).
