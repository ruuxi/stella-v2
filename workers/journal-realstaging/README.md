# stella-v2-journal-realstaging

An **isolated development/staging** Cloudflare Worker that proves the cloud
conversation journal on **real infrastructure**: a real SQLite-backed Durable
Object as the canonical ordered journal, and a real R2 bucket for rolled-over
cold segments. It is deliberately separate from the shared
`stella-v2-cloud-builder-dev` worker so exercising it cannot disturb other work,
and it omits the container sandbox so it deploys on the Free plan with no new
paid service.

This is **not** a loopback emulator. Every proof below is a real HTTPS call to a
Worker running on Cloudflare's edge, backed by real DO SQLite and real R2.

## Deployed dev/staging resources (non-secret)

| Resource | Value |
| --- | --- |
| Worker | `stella-v2-journal-realstaging` |
| URL | `https://stella-v2-journal-realstaging.lolruuxi.workers.dev` |
| Cloudflare account | `f34b91c9c7dc22f0aef0ba855a9f026f` (lolruuxi@gmail.com) |
| Durable Object (SQLite) | class `JournalDO`, binding `JOURNAL_DO`, migration `v1: new_sqlite_classes` |
| R2 bucket (segments) | `stella-v2-journal-realstaging-archive`, binding `CONVERSATION_ARCHIVE` |
| Auth | `Authorization: Bearer <DEV_JOURNAL_TOKEN>` (a Worker **secret**, never committed) |

The monotonic **Convex projection** is proven on an isolated dev deployment
(`journal-proj-dev` → `opulent-labrador-370`, `https://opulent-labrador-370.convex.cloud`),
separate from the shared `flexible-panther-999` dev backend. See
`convex/` in that deployment: `projections.projectFromJournal` (monotonic) and
`projections.getProjection`.

## Authority / data flow (same model as production)

- **Canonical:** the DO SQLite journal. Gapless `seq` from `meta.next_seq`
  (never `MAX(seq)+1` — rollover deletes rows). Ordered, append-only.
- **Idempotency:** `append_receipts` keyed by `writer_key`; a replayed batch
  returns the prior receipt (no duplicate, no split-brain).
- **Fencing:** optional `expectedSeq`; a stale writer is rejected `409`.
- **R2 cold storage:** `rollover` cuts resident hot rows into an
  `uploading→committed` R2 segment, drops them from SQLite, and advances
  `hot_min_seq`. Reads merge committed R2 segments with resident hot rows, so a
  clean client rebuilds the full transcript from cloud alone.
- **Convex projection:** derived, monotonic cross-device view; never
  authoritative for ordered history.

## Cloudflare Free plan note (correcting a prior misconception)

An earlier note claimed SQLite-backed Durable Objects require Workers Paid. That
is **incorrect** per current Cloudflare docs: Durable Objects — including
SQLite-backed DOs — are available on **Workers Free** with daily limits
(100k requests/day, 13,000 GB-s/day, 5M rows read/day, 100k rows written/day,
5 GB storage). This worker is deployed on the existing account with
`new_sqlite_classes` and requires no plan upgrade or new paid subscription. The
repository itself contains no doc/config asserting a paid requirement for DO
SQLite; this note exists to prevent the misconception from returning.

## Routes (all require the bearer token except `/health`)

```
GET  /health
POST /journal/:cid/append     { writerKey, events[], expectedSeq?, placement? }
GET  /journal/:cid/read?from=N
POST /journal/:cid/rollover   { throughSeq? }
GET  /journal/:cid/segments
GET  /journal/:cid/segment?key=...     # reads the segment object from R2
GET  /journal/:cid/stats
```

## Configuring cloud-enabled dev to target the real staging worker

`dev.config.jsonc` records the remote staging endpoint (non-secret). Standard
cloud-enabled dev reads `STELLA_CLOUD_JOURNAL_URL` from it and the bearer token
from the environment / a local `.dev.vars` (never committed):

```
STELLA_CLOUD_JOURNAL_URL=https://stella-v2-journal-realstaging.lolruuxi.workers.dev
STELLA_CLOUD_JOURNAL_TOKEN=<dev token>   # from `wrangler secret`, kept out of git
```

## Tests

- `tests/journal-core.test.ts` — deterministic unit tests of the canonical
  invariants (gapless seq, idempotency, fencing) backed by real `bun:sqlite`.
  These are the only local/in-process tests; they are **unit tests, not proof**
  of remote durability.
- `tests/remote-integration.test.ts` — real network proof against the deployed
  worker. Skipped unless `JOURNAL_URL` + `JOURNAL_TOKEN` are set:

```
JOURNAL_URL=https://stella-v2-journal-realstaging.lolruuxi.workers.dev \
JOURNAL_TOKEN=<dev token> bun test tests/remote-integration.test.ts
```

## Deploy

```
wrangler deploy                    # from this directory
echo <token> | wrangler secret put DEV_JOURNAL_TOKEN
```
