/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import {
  appendBatch,
  ensureSchema,
  FencingConflict,
  hotMinSeq,
  JOURNAL_DDL,
  lastSeq,
  listSegments,
  readHot,
  type AppendEvent,
  type JournalEventRow,
  type Sql,
} from "./journal-core";

// Canonical conversation journal as a real Durable Object backed by DO SQLite,
// with cold segments rolled over to a real R2 bucket. This is the same
// authority model as the production journal: the DO SQLite journal is canonical
// ordered history; R2 holds durable rolled-over segments; a client rebuilds the
// full transcript by merging committed R2 segments with the resident hot rows.

export interface Env {
  CONVERSATION_ARCHIVE: R2Bucket;
  DEV_JOURNAL_TOKEN: string;
}

interface SegmentObject {
  conversationId: string;
  firstSeq: number;
  lastSeq: number;
  events: JournalEventRow[];
}

export class JournalDO extends DurableObject<Env> {
  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // Adapter presenting DO SqlStorage through the storage-agnostic `Sql` surface
  // journal-core is written against (its generic is looser than SqlStorage's).
  private get core(): Sql {
    const sql = this.ctx.storage.sql;
    return {
      exec: (query: string, ...bindings: unknown[]) => {
        const cursor = sql.exec(query, ...(bindings as never[]));
        return {
          toArray: () => cursor.toArray() as never[],
          one: () => cursor.one() as never,
        };
      },
    };
  }

  private tx<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }

  async append(
    conversationId: string,
    writerKey: string,
    events: AppendEvent[],
    expectedSeq?: number,
  ): Promise<
    | { ok: true; receipt: ReturnType<typeof appendBatch>; lastSeq: number }
    | { ok: false; error: string; lastSeq: number; status: number }
  > {
    ensureSchema(this.core, Date.now());
    await this.ctx.storage.put("conversationId", conversationId);
    try {
      const receipt = this.tx(() => appendBatch(this.core, writerKey, events, Date.now(), expectedSeq));
      return { ok: true, receipt, lastSeq: lastSeq(this.core) };
    } catch (e) {
      if (e instanceof FencingConflict) {
        return { ok: false, error: e.message, lastSeq: e.actualLastSeq, status: 409 };
      }
      throw e;
    }
  }

  async read(fromSeq: number): Promise<{ events: JournalEventRow[]; lastSeq: number; hotMinSeq: number }> {
    ensureSchema(this.core, Date.now());
    // Merge committed R2 segments (cold) with the resident hot rows so a clean
    // client rebuilds the full ordered transcript from cloud alone.
    const segments = listSegments(this.core).filter((s) => s.state === "committed" && s.lastSeq >= fromSeq);
    const cold: JournalEventRow[] = [];
    for (const seg of segments) {
      const obj = await this.env.CONVERSATION_ARCHIVE.get(seg.r2Key);
      if (!obj) continue;
      const parsed = (await obj.json()) as SegmentObject;
      for (const ev of parsed.events) if (ev.seq >= fromSeq) cold.push(ev);
    }
    const hot = readHot(this.core, Math.max(fromSeq, hotMinSeq(this.core)));
    const all = [...cold, ...hot].sort((a, b) => a.seq - b.seq);
    return { events: all, lastSeq: lastSeq(this.core), hotMinSeq: hotMinSeq(this.core) };
  }

  /**
   * Roll the resident hot rows up to `throughSeq` into a single R2 segment,
   * then drop them from SQLite and advance hot_min_seq. This is the real
   * cold-storage path: after rollover the rows live only in R2 and are read
   * back on demand.
   */
  async rollover(
    throughSeq?: number,
  ): Promise<{ segment: { r2Key: string; firstSeq: number; lastSeq: number; rows: number; bytes: number } | null }> {
    ensureSchema(this.core, Date.now());
    const conversationId = (await this.ctx.storage.get<string>("conversationId")) ?? "conv";
    const hotMin = hotMinSeq(this.core);
    const top = lastSeq(this.core);
    const cut = throughSeq === undefined ? top : Math.min(throughSeq, top);
    if (cut < hotMin) return { segment: null };

    const rows = readHot(this.core, hotMin).filter((r) => r.seq <= cut);
    if (rows.length === 0) return { segment: null };

    const firstSeq = rows[0]!.seq;
    const lastSeqCut = rows[rows.length - 1]!.seq;
    const r2Key = `journal/${conversationId}/segment-${String(firstSeq).padStart(12, "0")}.json`;
    const body: SegmentObject = { conversationId, firstSeq, lastSeq: lastSeqCut, events: rows };
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;

    // Mark uploading, write to R2, then commit — mirrors the production
    // uploading->committed segment lifecycle so a crash mid-upload re-cuts.
    this.tx(() => {
      this.sql.exec(
        "INSERT OR REPLACE INTO segments (first_seq, last_seq, rows, bytes, r2_key, state, created_at) VALUES (?, ?, ?, ?, ?, 'uploading', ?)",
        firstSeq,
        lastSeqCut,
        rows.length,
        bytes,
        r2Key,
        Date.now(),
      );
    });
    await this.env.CONVERSATION_ARCHIVE.put(r2Key, JSON.stringify(body), {
      httpMetadata: { contentType: "application/json" },
    });
    this.tx(() => {
      this.sql.exec("UPDATE segments SET state = 'committed' WHERE first_seq = ?", firstSeq);
      this.sql.exec("DELETE FROM journal WHERE seq >= ? AND seq <= ?", firstSeq, lastSeqCut);
      this.sql.exec("UPDATE meta SET hot_min_seq = ? WHERE id = 0", lastSeqCut + 1);
    });

    return { segment: { r2Key, firstSeq, lastSeq: lastSeqCut, rows: rows.length, bytes } };
  }

  async segments(): Promise<ReturnType<typeof listSegments>> {
    ensureSchema(this.core, Date.now());
    return listSegments(this.core);
  }

  async readSegmentFromR2(r2Key: string): Promise<SegmentObject | null> {
    const obj = await this.env.CONVERSATION_ARCHIVE.get(r2Key);
    if (!obj) return null;
    return (await obj.json()) as SegmentObject;
  }

  async stats(): Promise<{ lastSeq: number; hotMinSeq: number; hotRows: number; segments: number }> {
    ensureSchema(this.core, Date.now());
    const hotRows = this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM journal").one().c;
    const segs = this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM segments").one().c;
    return { lastSeq: lastSeq(this.core), hotMinSeq: hotMinSeq(this.core), hotRows: Number(hotRows), segments: Number(segs) };
  }
}

export { JOURNAL_DDL };
