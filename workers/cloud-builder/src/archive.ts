/**
 * Cold storage for the conversation journal: R2 segments, oversize-row spills,
 * and the deletion path.
 *
 * Rollover is about unbounded growth and the deletion path, not about price —
 * DO SQLite and R2 both bill at $0.20/GB-month. What it buys is a resident set
 * whose size is a function of the CURRENT conversation rather than of its
 * lifetime, and a place to put bytes that the 10 GB per-object ceiling would
 * otherwise eventually meet.
 *
 * Two rules make the cut safe:
 *
 *  - Rows are never deleted before the R2 put resolves. The manifest records
 *    the intent first, the object is written second, and the delete + floor
 *    bump happen third in one transaction. A crash anywhere leaves rows
 *    resident and a segment marked 'uploading'; the next cut re-uploads that
 *    range first. The worst outcome is a duplicate object, never a lost row.
 *  - A cut lands only below the most recent turn's context start, at the end
 *    of a terminal turn, immediately before a plain user message. That is what
 *    keeps R2 off the agent loop's path entirely: a normal turn never reads a
 *    segment.
 */

import {
  BACKFILL_BATCH_BYTES,
  BACKFILL_BATCH_RECORDS,
  DB_PRESSURE_AGGRESSIVE_BYTES,
  DB_PRESSURE_AGGRESSIVE_ROWS,
  DB_PRESSURE_EMERGENCY_BYTES,
  DB_PRESSURE_EMERGENCY_ROWS,
  HOT_MAX_BYTES,
  HOT_MAX_ROWS,
  HOT_TARGET_BYTES,
  HOT_TARGET_ROWS,
  MAX_SEGMENTS_PER_READ,
  utf8Length,
  type ConversationLogger,
  type JournalRange,
  type JournalRecord,
} from "./conversation-types.js";
import { sha256Hex } from "./hash.js";
import {
  rewriteSegmentOwnership,
  transferArchiveKey,
} from "./owner-transfer.js";
import type {
  Journal,
  JournalRow,
  OwnerTransferObjectRow,
  SegmentRow,
} from "./journal.js";

/**
 * One cut is bounded independently of the residency target so a single
 * rollover can never build a multi-hundred-megabyte buffer in a 128 MB
 * isolate. A backlog drains over successive turns instead.
 */
const SEGMENT_MAX_ROWS = 1_000;
const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
const ARCHIVE_READ_ROWS = 500;
const PURGE_BATCH = 200;
const OWNER_TRANSFER_BATCH = 4;
/**
 * How many delete batches may fail before this pass gives up and lets Convex's
 * sweep retry. Bounded rather than "until it works": the caller is holding an
 * HTTP request open, and the queue is durable.
 */
const PURGE_MAX_FAILED_BATCHES = 3;
const R2_TIMEOUT_MS = 30_000;

const pad = (value: number): string => String(value).padStart(12, "0");

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Archive storage timed out.")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export type SegmentHeader = {
  v: 1;
  conversationId: string;
  ownerId: string;
  epoch: number;
  firstSeq: number;
  lastSeq: number;
  rows: number;
  createdAt: number;
};

export class ConversationArchive {
  private ownerHashCache: { ownerId: string; hash: string } | null = null;

  /**
   * The R2 writes this object has started and not yet finished.
   *
   * Every one of them registers its key in SQLite before it settles — a
   * segment in `segments` before the upload, a spill in `spills` immediately
   * after the put. So once this set is empty, the manifest names every object
   * that exists. That is the whole property `quiesce()` sells to the purge:
   * without it the deletion snapshot is taken against a manifest that a
   * still-running rollover or spill is about to add to, and `deleteAll()`
   * destroys the only record of whatever landed late.
   */
  private readonly inFlight = new Set<Promise<unknown>>();

  /**
   * Set by the purge, never cleared. The durable tombstone cannot carry this
   * fence on its own: `deleteAll()` destroys it, and the purge handler then
   * re-bootstraps an empty journal so the object can keep refusing requests —
   * which means `journal.isDeleted()` reads false again the moment the purge
   * returns. A request that was already in flight resumes against that empty
   * journal and writes an R2 object under the deleted conversation's prefix
   * that no manifest, queue or sweep has ever heard of. This flag is what stays
   * true across the wipe, for as long as the isolate lives.
   */
  private sealed = false;

  seal(): void {
    this.sealed = true;
  }

  constructor(
    private readonly bucket: R2Bucket | undefined,
    private readonly journal: Journal,
    private readonly log: ConversationLogger,
  ) {}

  get available(): boolean {
    return this.bucket !== undefined;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const tracked = work.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }

  /**
   * Waits until no R2 write this object started is still running. Called by the
   * purge after the tombstone is set and before it snapshots the keys to
   * delete: the tombstone stops new writes from starting, this waits out the
   * ones that had already started, and together they make "the manifest names
   * every object" true rather than probable.
   *
   * Settled, not fulfilled: a write that failed still owes its key to the
   * manifest, and a rejection propagating from here would abandon the purge.
   * The pass limit bounds the wait — a tracked write that spawns another can
   * otherwise keep this loop alive, and the purge is holding an HTTP request
   * open.
   */
  async quiesce(): Promise<void> {
    for (let pass = 0; pass < 4 && this.inFlight.size > 0; pass += 1) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async transferOwner(
    fromPrefix: string,
    toPrefix: string,
    toOwnerId: string,
  ): Promise<{ complete: boolean; pending: number }> {
    await this.quiesce();
    // A crash during rollover can leave a durable uploading row whose source
    // object was never put. Recover it under the old owner prefix before the
    // transfer enumerates archive keys, otherwise that missing source would
    // make every transfer retry fail at the same row.
    await this.finishPendingSegment();
    let copying = this.journal.ownerTransferObjects(
      "copying",
      OWNER_TRANSFER_BATCH,
    );
    if (copying.length === 0) {
      const sources = this.journal.ownerTransferSourceKeys(
        fromPrefix,
        OWNER_TRANSFER_BATCH,
      );
      for (const source of sources) {
        const target = transferArchiveKey(source.key, fromPrefix, toPrefix);
        if (!target) continue;
        this.journal.enqueueOwnerTransferObject(
          source.key,
          target,
          source.kind,
        );
      }
      copying = this.journal.ownerTransferObjects(
        "copying",
        OWNER_TRANSFER_BATCH,
      );
    }

    for (const row of copying) {
      await this.copyOwnerTransferObject(row, toOwnerId, fromPrefix, toPrefix);
      this.journal.rewriteOwnerTransferObject(row);
    }
    if (copying.length > 0) {
      return {
        complete: false,
        pending:
          this.journal.ownerTransferPending() +
          this.journal.ownerTransferSourceKeys(fromPrefix, 1).length,
      };
    }
    if (this.journal.ownerTransferSourceKeys(fromPrefix, 1).length > 0) {
      return {
        complete: false,
        pending: this.journal.ownerTransferPending() + 1,
      };
    }

    const cleanup = this.journal.ownerTransferObjects(
      "cleanup",
      OWNER_TRANSFER_BATCH,
    );
    if (cleanup.length > 0) {
      if (!this.bucket) {
        throw new Error("Conversation archive storage is unavailable.");
      }
      await withTimeout(
        this.bucket.delete(cleanup.map((row) => row.old_key)),
        R2_TIMEOUT_MS,
      );
      for (const row of cleanup) {
        this.journal.completeOwnerTransferObject(row.old_key);
      }
    }
    const pending = this.journal.ownerTransferPending();
    return { complete: pending === 0, pending };
  }

  private async copyOwnerTransferObject(
    row: OwnerTransferObjectRow,
    toOwnerId: string,
    fromPrefix: string,
    toPrefix: string,
  ): Promise<void> {
    if (!this.bucket) {
      throw new Error("Conversation archive storage is unavailable.");
    }
    const existing = await withTimeout(
      this.bucket.head(row.new_key),
      R2_TIMEOUT_MS,
    );
    if (existing) return;
    const source = await withTimeout(
      this.bucket.get(row.old_key),
      R2_TIMEOUT_MS,
    );
    if (!source) {
      throw new Error(`Conversation archive object is missing: ${row.old_key}`);
    }
    const body =
      row.kind === "segment"
        ? await rewriteSegmentOwnership(
            await source.arrayBuffer(),
            toOwnerId,
            fromPrefix,
            toPrefix,
          )
        : source.body;
    await withTimeout(
      this.bucket.put(row.new_key, body, {
        httpMetadata: source.httpMetadata,
        customMetadata: source.customMetadata,
      }),
      R2_TIMEOUT_MS,
    );
  }

  private async prefix(): Promise<string | null> {
    const meta = this.journal.meta();
    if (!meta.owner_id || !meta.conversation_id) return null;
    if (this.ownerHashCache?.ownerId !== meta.owner_id) {
      this.ownerHashCache = {
        ownerId: meta.owner_id,
        hash: await sha256Hex(meta.owner_id),
      };
    }
    return `conversations/${this.ownerHashCache.hash}/${meta.conversation_id}`;
  }

  // -------------------------------------------------------------------------
  // Spill
  // -------------------------------------------------------------------------

  /**
   * Keyed by a hash of the writer key rather than by seq: the key has to exist
   * before a seq is allocated for a synchronous append to reference it, and a
   * deterministic key makes a retried spill overwrite identical bytes instead
   * of leaking a second object.
   *
   * The key is registered in `spills` here — at the one site that creates the
   * object — rather than wherever a row happens to reference it. The row is
   * not a durable record of the key: rollover deletes archived rows, and an
   * append that fails after this put never writes one at all. Registering
   * before returning means every object this method creates is nameable by the
   * purge, whatever happens next.
   */
  async writeSpill(
    writerKey: string,
    payloadJson: string,
  ): Promise<string | null> {
    if (!this.bucket) return null;
    // The fence: refusing here is what stops an object being created behind
    // the purge's snapshot. A spill that had already started when the purge
    // landed is not refused — it is tracked, so the purge waits for it and
    // finds its key.
    if (this.sealed || this.journal.isDeleted()) return null;
    return this.track(this.spill(writerKey, payloadJson));
  }

  private async spill(
    writerKey: string,
    payloadJson: string,
  ): Promise<string | null> {
    const prefix = await this.prefix();
    if (!this.bucket || !prefix) return null;
    const key = `${prefix}/spill/${(await sha256Hex(writerKey)).slice(0, 32)}.json.gz`;
    const body = await gzip([new TextEncoder().encode(payloadJson)]);
    await withTimeout(this.bucket.put(key, body), R2_TIMEOUT_MS);
    // Registered whether or not the conversation was tombstoned while the put
    // was in flight: an unregistered object is an undeletable one, and this
    // table is what the purge reads.
    this.journal.recordSpill(key, utf8Length(payloadJson), Date.now());
    return key;
  }

  async readSpill(key: string): Promise<unknown | null> {
    if (!this.bucket) return null;
    const object = await withTimeout(this.bucket.get(key), R2_TIMEOUT_MS);
    if (!object) return null;
    const text = await new Response(
      object.body.pipeThrough(new DecompressionStream("gzip")),
    ).text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Rollover
  // -------------------------------------------------------------------------

  /**
   * Called only after a turn reached a terminal state AND its terminal event
   * was delivered — never mid-turn, never on a socket read path. Failures are
   * logged and swallowed: a conversation that cannot roll over is larger than
   * we would like, not broken.
   */
  async maybeRollover(now: number): Promise<void> {
    if (!this.bucket) return;
    if (this.sealed || this.journal.isDeleted()) return;
    return this.track(this.rollover(now));
  }

  private async rollover(now: number): Promise<void> {
    try {
      await this.finishPendingSegment();
      // Re-checked after the first await, and again before the cut: a purge
      // that lands mid-pass must not get a fresh object written behind it. The
      // pass already in flight is covered by `quiesce()`, not by this.
      if (this.sealed || this.journal.isDeleted()) return;
      const hot = this.journal.hotStats();
      const dbBytes = this.journal.databaseSize();
      let targetRows = HOT_TARGET_ROWS;
      let targetBytes = HOT_TARGET_BYTES;
      let tier = "normal";
      if (dbBytes > DB_PRESSURE_EMERGENCY_BYTES) {
        targetRows = DB_PRESSURE_EMERGENCY_ROWS;
        targetBytes = 0;
        tier = "emergency";
      } else if (dbBytes > DB_PRESSURE_AGGRESSIVE_BYTES) {
        targetRows = DB_PRESSURE_AGGRESSIVE_ROWS;
        targetBytes = 0;
        tier = "aggressive";
      } else if (hot.rows <= HOT_MAX_ROWS && hot.bytes <= HOT_MAX_BYTES) {
        return;
      }
      if (tier !== "normal") {
        this.log("error", "conversation_storage_pressure", {
          tier,
          databaseBytes: dbBytes,
          hotRows: hot.rows,
        });
      }
      const cutSeq = this.resolveCut(targetRows, targetBytes);
      if (cutSeq === null) {
        this.log("info", "rollover_no_boundary", {
          hotRows: hot.rows,
          hotBytes: hot.bytes,
        });
        return;
      }
      await this.cut(cutSeq, now);
    } catch (error) {
      this.log("error", "conversation_rollover_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The three conditions, all required:
   *  1. strictly below the most recent turn's context start — this is what
   *     makes R2 non-load-bearing for a normal turn;
   *  2. the last row of a turn that reached a terminal state;
   *  3. followed immediately by a plain user message, so the resident window
   *     can never open on an orphaned tool result.
   */
  private resolveCut(targetRows: number, targetBytes: number): number | null {
    const desired = this.journal.desiredCutSeq(targetRows, targetBytes);
    if (desired === null) return null;
    const latest = this.journal.latestTerminalTurn();
    const ceiling =
      latest?.ctx_start_seq != null
        ? Math.min(desired, latest.ctx_start_seq - 1)
        : desired;
    if (ceiling < 0) return null;
    const candidates = this.journal.terminalTurnBoundaries(500);
    let best: number | null = null;
    for (const candidate of candidates) {
      if (candidate.last_seq > ceiling) break;
      if (!this.journal.isCutBoundary(candidate.last_seq)) continue;
      best = candidate.last_seq;
    }
    return best;
  }

  private async cut(cutSeq: number, now: number): Promise<void> {
    const meta = this.journal.meta();
    const prefix = await this.prefix();
    if (!this.bucket || !prefix) return;
    if (this.sealed || this.journal.isDeleted()) return;
    const firstSeq = meta.hot_min_seq;
    if (cutSeq < firstSeq) return;
    const rows = this.journal.rowsForArchive(
      firstSeq,
      cutSeq,
      SEGMENT_MAX_ROWS,
    );
    if (rows.length === 0) return;
    let bytes = 0;
    let lastSeq = rows[0]!.seq;
    let count = 0;
    for (const row of rows) {
      if (count > 0 && bytes + row.bytes > SEGMENT_MAX_BYTES) break;
      bytes += row.bytes;
      lastSeq = row.seq;
      count += 1;
    }
    // Truncating the batch can land the tail mid-turn. Only a boundary is a
    // legal segment end, so walk back to one; if the very first rows exceed
    // the byte cap there is nothing safe to cut this pass.
    while (lastSeq > firstSeq && !this.journal.isCutBoundary(lastSeq)) {
      lastSeq -= 1;
    }
    if (lastSeq < firstSeq || !this.journal.isCutBoundary(lastSeq)) return;
    const key = `${prefix}/seg/${pad(firstSeq)}-${pad(lastSeq)}.jsonl.gz`;
    const header: SegmentHeader = {
      v: 1,
      conversationId: meta.conversation_id,
      ownerId: meta.owner_id,
      epoch: meta.epoch,
      firstSeq,
      lastSeq,
      rows: count,
      createdAt: now,
    };
    // Phase 1: durable intent. No rows deleted.
    this.journal.insertSegment({
      first_seq: firstSeq,
      last_seq: lastSeq,
      rows: count,
      bytes,
      r2_key: key,
      state: "uploading",
      created_at: now,
    });
    // Phase 2: the object. Same range means the same key, so a retry
    // overwrites identical bytes.
    await this.upload(key, header, firstSeq, lastSeq);
    // Phase 3: commit, delete, raise the floor — one transaction.
    this.journal.commitSegment(firstSeq, lastSeq);
    this.log("info", "conversation_segment_committed", {
      firstSeq,
      lastSeq,
      rows: count,
      bytes,
    });
  }

  /** Re-runs phase 2 for a range whose previous cut crashed mid-upload. */
  private async finishPendingSegment(): Promise<void> {
    const pending = this.journal.pendingSegment();
    if (!pending) return;
    const meta = this.journal.meta();
    await this.upload(
      pending.r2_key,
      {
        v: 1,
        conversationId: meta.conversation_id,
        ownerId: meta.owner_id,
        epoch: meta.epoch,
        firstSeq: pending.first_seq,
        lastSeq: pending.last_seq,
        rows: pending.rows,
        createdAt: pending.created_at,
      },
      pending.first_seq,
      pending.last_seq,
    );
    this.journal.commitSegment(pending.first_seq, pending.last_seq);
    this.log("info", "conversation_segment_recovered", {
      firstSeq: pending.first_seq,
      lastSeq: pending.last_seq,
    });
  }

  /**
   * Every column travels, `writer_key` included, so re-importing a segment is
   * a byte-identical no-op against the UNIQUE index.
   *
   * `contentEncoding` is deliberately NOT set: whether the R2 binding
   * transparently decodes a gzip-encoded body on `get()` is exactly the kind
   * of ambiguity that works in one runtime and not the next. The `.gz` suffix
   * carries the meaning and this module always decompresses explicitly.
   */
  private async upload(
    key: string,
    header: SegmentHeader,
    firstSeq: number,
    lastSeq: number,
  ): Promise<void> {
    if (!this.bucket) throw new Error("No conversation archive bucket bound.");
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [
      encoder.encode(`${JSON.stringify(header)}\n`),
    ];
    let cursor = firstSeq;
    for (;;) {
      const batch = this.journal.rowsForArchive(
        cursor,
        lastSeq,
        ARCHIVE_READ_ROWS,
      );
      if (batch.length === 0) break;
      let text = "";
      for (const row of batch) text += `${JSON.stringify(row)}\n`;
      chunks.push(encoder.encode(text));
      cursor = batch[batch.length - 1]!.seq + 1;
      if (cursor > lastSeq) break;
    }
    const body = await gzip(chunks);
    await withTimeout(this.bucket.put(key, body), R2_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Client-facing only. The agent loop never calls this: its window is chosen
   * from resident rows, and the cut rule guarantees the window is resident.
   */
  async readRange(
    fromSeq: number,
    toSeq: number,
    limit: number,
  ): Promise<JournalRange> {
    const head = this.journal.head();
    const start = Math.max(0, fromSeq);
    const end = Math.min(toSeq, head.headSeq);
    if (end < start) return { records: [], complete: true };
    const maxRecords = Math.min(limit, BACKFILL_BATCH_RECORDS);
    const records: JournalRecord[] = [];
    let missingBelowSeq: number | undefined;
    // The high-water mark of what has been served. Everything below it in the
    // requested range is either in `records` or named by `missingBelowSeq`.
    let cursor = start;

    if (cursor < head.windowStartSeq) {
      const coldEnd = Math.min(end, head.windowStartSeq - 1);
      const segments = this.journal.segmentsCovering(
        cursor,
        coldEnd,
        MAX_SEGMENTS_PER_READ,
      );
      const lowestCovered = segments[0]?.first_seq;
      if (lowestCovered === undefined || lowestCovered > cursor) {
        // Compacted past what the manifest still names, or never allocated.
        // Either way it can never be served: name it rather than looping.
        missingBelowSeq = lowestCovered ?? head.windowStartSeq;
        cursor = missingBelowSeq;
      }
      for (const segment of segments) {
        if (records.length >= maxRecords) break;
        const rows = await this.readSegment(segment);
        for (const row of rows) {
          if (row.seq < cursor || row.seq > coldEnd) continue;
          if (records.length >= maxRecords) break;
          records.push(this.journal.rowToRecord(row));
          cursor = row.seq + 1;
        }
      }
      // Short of the cold end means the per-request segment cap (or a hole in
      // a segment) cut this response; the client re-asks from `cursor`.
      if (cursor <= coldEnd) {
        return {
          records,
          complete: false,
          ...(missingBelowSeq !== undefined ? { missingBelowSeq } : {}),
        };
      }
    }

    if (records.length < maxRecords && cursor <= end) {
      const resident = this.journal.readResident(
        Math.max(cursor, head.windowStartSeq),
        end,
        maxRecords - records.length,
        BACKFILL_BATCH_BYTES,
      );
      records.push(...resident.records);
      return {
        records,
        complete: resident.complete,
        ...(missingBelowSeq !== undefined ? { missingBelowSeq } : {}),
      };
    }

    return {
      records,
      complete: cursor > end,
      ...(missingBelowSeq !== undefined ? { missingBelowSeq } : {}),
    };
  }

  private async readSegment(segment: SegmentRow): Promise<JournalRow[]> {
    if (!this.bucket) return [];
    const object = await withTimeout(
      this.bucket.get(segment.r2_key),
      R2_TIMEOUT_MS,
    );
    if (!object) {
      this.log("error", "conversation_segment_missing", {
        r2Key: segment.r2_key,
        firstSeq: segment.first_seq,
      });
      return [];
    }
    const text = await new Response(
      object.body.pipeThrough(new DecompressionStream("gzip")),
    ).text();
    const rows: JournalRow[] = [];
    let first = true;
    for (const line of text.split("\n")) {
      if (!line) continue;
      if (first) {
        first = false; // header
        continue;
      }
      try {
        rows.push(JSON.parse(line) as JournalRow);
      } catch {
        // A corrupt line degrades scrollback; it must not fail the read.
      }
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  /**
   * Drains `purge_queue`, removing only keys R2 confirmed. The caller must not
   * call `deleteAll()` until this reports zero pending: `deleteAll()` destroys
   * the manifest, which is the only record of the keys, and the objects would
   * then be unreachable forever.
   *
   * The caller must also have tombstoned the conversation and awaited
   * `quiesce()` before it snapshotted those keys. A key that reaches the
   * manifest after the snapshot is a key this drain never sees, and the
   * `deleteAll()` behind it takes the last record of the object with it.
   */
  async drainPurge(): Promise<{ pending: number }> {
    if (!this.bucket) {
      // Nothing was ever written, so nothing can be orphaned.
      for (;;) {
        const keys = this.journal.purgeBatch(PURGE_BATCH);
        if (keys.length === 0) break;
        this.journal.purgeDone(keys);
      }
      return { pending: this.journal.purgePending() };
    }
    // A failed batch does not end the drain: `purgeBatch` orders by attempts,
    // so the next pass picks up keys this one never reached instead of
    // re-offering the batch that just failed. The failure budget is what stops
    // that from spinning once every remaining key is failing.
    let failures = 0;
    for (;;) {
      const keys = this.journal.purgeBatch(PURGE_BATCH);
      if (keys.length === 0) break;
      try {
        await withTimeout(this.bucket.delete(keys), R2_TIMEOUT_MS);
        this.journal.purgeDone(keys);
      } catch (error) {
        this.journal.purgeFailed(keys);
        this.log("error", "conversation_purge_delete_failed", {
          keys: keys.length,
          message: error instanceof Error ? error.message : String(error),
        });
        failures += 1;
        if (failures >= PURGE_MAX_FAILED_BATCHES) break;
      }
    }
    return { pending: this.journal.purgePending() };
  }
}

const gzip = async (chunks: Uint8Array[]): Promise<ArrayBuffer> => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return await new Response(
    source.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
};
