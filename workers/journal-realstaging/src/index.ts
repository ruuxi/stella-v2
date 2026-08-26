/// <reference types="@cloudflare/workers-types" />
import { JournalDO, type Env } from "./journal-do";
import type { AppendEvent } from "./journal-core";

export { JournalDO };

// Isolated development/staging journal worker. Real Durable Object (SQLite) +
// real R2 segment archive. No user-facing surface; a single dev bearer token
// guards every route so this staging journal can be exercised over the real
// network without the production Convex-JWT stack.
//
// Routes (all require Authorization: Bearer <DEV_JOURNAL_TOKEN>):
//   GET  /health
//   POST /journal/:cid/append     { writerKey, events[], expectedSeq?, placement? }
//   GET  /journal/:cid/read?from=N
//   POST /journal/:cid/rollover   { throughSeq? }        -> cut hot rows to R2
//   GET  /journal/:cid/segments                          -> segment manifests
//   GET  /journal/:cid/segment?key=...                   -> read segment from R2
//   GET  /journal/:cid/stats

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized(): Response {
  return json({ ok: false, error: "unauthorized" }, 401);
}

// The DO's callable surface. Written by hand because DurableObjectStub RPC
// return-type inference collapses these method returns to `never` under this
// tsconfig; the runtime RPC calls are unaffected.
type JournalStub = Pick<
  JournalDO,
  "append" | "read" | "rollover" | "segments" | "readSegmentFromR2" | "stats"
>;

function stub(env: Env, conversationId: string): JournalStub {
  const ns = (env as unknown as { JOURNAL_DO: DurableObjectNamespace<JournalDO> }).JOURNAL_DO;
  const id = ns.idFromName(conversationId);
  return ns.get(id) as unknown as JournalStub;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "health") {
      return json({ ok: true, worker: "stella-v2-journal-realstaging", now: Date.now() });
    }

    // Auth gate for everything else.
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.DEV_JOURNAL_TOKEN || token !== env.DEV_JOURNAL_TOKEN) {
      return unauthorized();
    }

    // /journal/:cid/:action
    if (parts[0] !== "journal" || parts.length < 3) {
      return json({ ok: false, error: "not found" }, 404);
    }
    const conversationId = parts[1]!;
    const action = parts[2]!;
    const s = stub(env, conversationId);

    try {
      if (action === "append" && request.method === "POST") {
        const body = (await request.json()) as {
          writerKey?: string;
          events?: AppendEvent[];
          expectedSeq?: number;
          placement?: AppendEvent["placement"];
        };
        if (!body.writerKey) return json({ ok: false, error: "writerKey required" }, 400);
        const events = (body.events ?? []).map((e) => ({ ...e, placement: e.placement ?? body.placement ?? null }));
        const result = await s.append(conversationId, body.writerKey, events, body.expectedSeq);
        if (!result.ok) return json({ ok: false, error: result.error, lastSeq: result.lastSeq }, result.status);
        return json({ ok: true, receipt: result.receipt, lastSeq: result.lastSeq });
      }

      if (action === "read" && request.method === "GET") {
        const from = Number(url.searchParams.get("from") ?? "1");
        const result = await s.read(Number.isFinite(from) && from > 0 ? from : 1);
        return json({ ok: true, events: result.events, lastSeq: result.lastSeq, hotMinSeq: result.hotMinSeq });
      }

      if (action === "rollover" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { throughSeq?: number };
        const result = await s.rollover(body.throughSeq);
        return json({ ok: true, segment: result.segment });
      }

      if (action === "segments" && request.method === "GET") {
        return json({ ok: true, segments: await s.segments() });
      }

      if (action === "segment" && request.method === "GET") {
        const key = url.searchParams.get("key");
        if (!key) return json({ ok: false, error: "key required" }, 400);
        const seg = await s.readSegmentFromR2(key);
        if (!seg) return json({ ok: false, error: "segment not found in R2" }, 404);
        return json({ ok: true, segment: seg });
      }

      if (action === "stats" && request.method === "GET") {
        return json({ ok: true, stats: await s.stats() });
      }
    } catch (e) {
      return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
