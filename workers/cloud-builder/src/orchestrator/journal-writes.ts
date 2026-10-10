import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import type { ConversationDeletedEvent } from "@stella/contracts/turn-plane/owner-events";
import { sha256Hex } from "../hash.js";
import {
  APPEND_MAX_BYTES,
  APPEND_MAX_ROWS,
  APPEND_WINDOW_MAX_BYTES,
  APPEND_WINDOW_MAX_REQUESTS,
  APPEND_WINDOW_MS,
  CLOSE_DELETED,
  CONVERSATION_MAX_STORED_BYTES,
  type ConversationCard,
  INBOX_MAX_BYTES,
  INBOX_MAX_ROWS,
  type JournalRecord,
  MAX_ROW_BYTES,
  type MessageRole,
  utf8Length,
} from "../conversation-types.js";
import { ConversationDeletedError } from "../journal.js";
import {
  LOCAL_DEVICE_ID_PATTERN,
  LOCAL_TURN_ID_PATTERN,
  parseExpectedOwnerGeneration,
} from "../local-turn-protocol.js";
import { parseVoiceJournalRecords } from "../journal-append-protocol.js";
import type { ChatTurnRequest, OwnerFencedTurn } from "./types.js";
import { json, errorMessage, log, truncateMessage } from "./support.js";
import { OrchestratorRunTurn } from "./run-turn.js";

/** Journal append, card, and purge routes. */
export abstract class OrchestratorJournalWrites extends OrchestratorRunTurn {
  /**
   * Realtime voice records, written into the cloud conversation without
   * pretending the voice provider owns the text-turn lease. The authenticated
   * owner comparison preserves lane scope, and the strict parser below accepts
   * message records only — no caller can manufacture turn lifecycle rows.
   */
  protected async handleJournalAppend(request: Request): Promise<Response> {
    const ownerId = request.headers.get("x-stella-owner") ?? "";
    if (!ownerId) return json({ error: "Unauthorized." }, 401);
    if (this.purged()) {
      return json(
        { code: "deleted", message: "This conversation was deleted." },
        410,
      );
    }
    let body: {
      deviceId?: string;
      expectedOwnerGeneration?: unknown;
      localTurnId?: string;
      source?: unknown;
      records?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const deviceId = body.deviceId?.trim();
    const expectedOwnerGeneration = parseExpectedOwnerGeneration(
      body.expectedOwnerGeneration,
    );
    const localTurnId = body.localTurnId?.trim();
    const records = body.records;
    if (
      !deviceId ||
      !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
      !expectedOwnerGeneration ||
      !localTurnId ||
      !LOCAL_TURN_ID_PATTERN.test(localTurnId) ||
      body.source !== "voice" ||
      !Array.isArray(records) ||
      records.length === 0
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const ownerRecord = await this.resolveOwnerForCaller(
      { ownerId },
      { refreshGeneration: true },
    );
    // Voice append is a fresh owner write. A refused resolution must not fall
    // back to the DO's cached binding or cached lifecycle generation,
    // including on idempotent receipt replay.
    if (!ownerRecord) {
      return json({ error: "Conversation not found." }, 404);
    }
    const bound = this.journal.ownerId() || ownerRecord.ownerId;
    if (!bound) return json({ error: "Conversation not found." }, 404);
    if (bound !== ownerId)
      return json({ error: "Conversation not found." }, 404);
    const currentOwnerGeneration = ownerRecord.ownerGeneration;
    if (currentOwnerGeneration !== expectedOwnerGeneration) {
      return json(
        {
          code: "owner_generation_stale",
          message: "This cloud owner generation is no longer current.",
        },
        409,
      );
    }
    if (records.length > APPEND_MAX_ROWS) {
      return json(
        {
          code: "too_many_records",
          message: "That's more history than one request can carry.",
        },
        413,
      );
    }
    const parsedRecords = parseVoiceJournalRecords(records);
    if (!parsedRecords) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    let totalBytes = 0;
    for (const record of parsedRecords)
      totalBytes += utf8Length(record.payloadJson);
    if (totalBytes > APPEND_MAX_BYTES) {
      return json(
        {
          code: "too_large",
          message: "That's more history than one request can carry.",
        },
        413,
      );
    }
    const source = "voice" as const;
    const receiptKey = `${source}:${deviceId}:${localTurnId}`;
    const turnId = `${source}:${deviceId}:${localTurnId}`;
    const appendLease: OwnerFencedTurn = {
      ownerId: bound,
      ownerGeneration: expectedOwnerGeneration,
      turnId,
    };
    try {
      appendLease.ownerPurgeGeneration = await this.registerOwnerTurn(
        appendLease,
        true,
      );
    } catch {
      return json(
        { code: "owner_purge", message: "Cloud activity is being reset." },
        409,
      );
    }
    let settleAppend!: () => void;
    const appendSettled = new Promise<void>((resolve) => {
      settleAppend = resolve;
    });
    const activeAppend = { lease: appendLease, settled: appendSettled };
    const appendLeaseId = appendLease.ownerPurgeLeaseId;
    if (!appendLeaseId) {
      await this.unregisterOwnerTurn(appendLease);
      return json(
        { code: "owner_purge", message: "Cloud activity is being reset." },
        409,
      );
    }
    this.ownerFencedAppends.set(appendLeaseId, activeAppend);
    try {
      const fingerprint = await sha256Hex(
        JSON.stringify({
          deviceId,
          expectedOwnerGeneration,
          localTurnId,
          source,
          records,
        }),
      );
      const receiptResponse = (): Response | null => {
        const receipt = this.journal.appendReceipt(receiptKey);
        if (!receipt) return null;
        if (receipt.fingerprint !== fingerprint) {
          return json(
            {
              code: "idempotency_conflict",
              message: "That append id was already used for different history.",
            },
            409,
          );
        }
        return json({
          firstSeq: receipt.first_seq,
          lastSeq: receipt.last_seq,
          epoch: receipt.epoch,
          replayed: true,
        });
      };
      const replay = receiptResponse();
      if (replay) return replay;
      // The lifetime ceiling. Resident bytes alone would not bound this —
      // rollover moves them to R2, and an oversize row spills there directly —
      // so `storedBytes` counts archived segments and spill objects too, and a
      // conversation cannot grow forever by pushing its bytes out of SQLite.
      const storedBytes = this.journal.storedBytes();
      if (storedBytes + totalBytes > CONVERSATION_MAX_STORED_BYTES) {
        log("error", "conversation_storage_ceiling", {
          conversationId: this.conversationId(),
          storedBytes,
        });
        return json(
          {
            code: "conversation_full",
            message:
              "This conversation has reached its size limit. Start a new conversation to keep going.",
          },
          413,
        );
      }
      // Per-request caps bound one request; the window bounds a loop of them.
      // Tested here, before any R2 spill, so a runaway client is refused before
      // it can make the DO do work — and charged only once the rows are
      // committed, below, so a 409 against a running turn never eats the
      // allowance the client needs in order to retry.
      const budgetArgs = {
        bytes: totalBytes,
        windowMs: APPEND_WINDOW_MS,
        maxRequests: APPEND_WINDOW_MAX_REQUESTS,
        maxBytes: APPEND_WINDOW_MAX_BYTES,
      };
      const probe = this.journal.appendBudget({
        ...budgetArgs,
        now: Date.now(),
        commit: false,
      });
      if (!probe.allowed) {
        return json(
          {
            code: "rate_limited",
            message:
              "That's more history than this conversation can take right now.",
            retryAfterMs: probe.retryAfterMs,
          },
          429,
        );
      }
      // The running-turn refusal, taken twice for two different reasons. This
      // one is about cost: the spilling below writes to R2, and the check that
      // can refuse this request must not sit behind it — a client that keeps
      // asking while a turn runs would otherwise pay for every one of those
      // objects with a 409 and, because the window is charged only on the
      // committed path, no rate accounting at all.
      if (await this.turnRunning()) {
        return json(
          {
            code: "turn_in_progress",
            message: "Stella is mid-reply — try again in a moment.",
            retryAfterMs: 3_000,
          },
          409,
        );
      }
      // Everything that can await — parsing, oversize spilling — happens BEFORE
      // the second running-turn check, so that check and the appends form one
      // uninterrupted block. An await between them would reopen the input gate
      // and let a turn start in the gap, which is the one ordering that can
      // splice a foreign row between a tool call and its result.
      const now = Date.now();
      const prepared: Array<{
        kind: "message";
        writerKey: string;
        role: MessageRole;
        hidden: boolean;
        message: AgentMessage;
        payloadJson: string;
        spillKey?: string;
      }> = [];
      for (let ordinal = 0; ordinal < parsedRecords.length; ordinal += 1) {
        const record = parsedRecords[ordinal]!;
        const writerKey = `${source}:${deviceId}:${localTurnId}:${ordinal}`;
        const sized = await this.prepareOversize(
          record.role,
          record.message,
          record.payloadJson,
          writerKey,
        );
        prepared.push({
          kind: "message",
          writerKey,
          role: record.role,
          hidden: record.hidden,
          message: sized.message,
          payloadJson: sized.payloadJson,
          ...(sized.spillKey ? { spillKey: sized.spillKey } : {}),
        });
      }

      try {
        // Registration keeps generation rotation waiting; this second check
        // catches a purge that closed the fence while R2 oversize preparation
        // was in flight, before the SQLite transaction can append anything.
        await this.assertOwnerTurn(appendLease);
      } catch {
        return json(
          { code: "owner_purge", message: "Cloud activity is being reset." },
          409,
        );
      }

      let firstSeq: number | null = null;
      let lastSeq = -1;
      const publishAfterCommit: JournalRecord[] = [];
      let finalResponse: Response | null = null;
      let appendFailure: unknown;
      // Everything below is one input-gate critical section. The storage reads
      // may yield, but `blockConcurrencyWhile` prevents a queued text turn
      // from being admitted between the final checks and the synchronous
      // journal transaction.
      await this.ctx.blockConcurrencyWhile(async () => {
        if (await this.turnRunning()) {
          finalResponse = json(
            {
              code: "turn_in_progress",
              message: "Stella is mid-reply — try again in a moment.",
              retryAfterMs: 3_000,
            },
            409,
          );
          return;
        }
        if (this.purged()) {
          finalResponse = json(
            { code: "deleted", message: "This conversation was deleted." },
            410,
          );
          return;
        }
        const racedReplay = receiptResponse();
        if (racedReplay) {
          finalResponse = racedReplay;
          return;
        }
        try {
          // Synchronous, and inside the same uninterrupted block as the appends:
          // this is the request the window is actually paying for.
          this.journal.appendBudget({ ...budgetArgs, now, commit: true });
          const writer = `${source}:${deviceId}`;
          // Registered in the projection so a foreign turn is also a legal
          // rollover boundary; without it a chatty desktop could wedge every cut
          // point behind rows no cut is allowed to land on.
          this.journal.transactionSync(() => {
            this.journal.upsertTurn({
              turnId,
              sessionId: `${source}-${deviceId}`.slice(0, 64),
              ownerId: bound,
              lane: "chat",
              source,
              state: "terminal",
              now,
            });
            for (const entry of prepared) {
              const appended = this.journal.appendMessage({
                turnId,
                writer,
                writerKey: entry.writerKey,
                role: entry.role,
                hidden: entry.hidden,
                message: entry.message,
                payloadJson: entry.payloadJson,
                ...(entry.spillKey ? { spillKey: entry.spillKey } : {}),
                createdAt: now,
              });
              if (firstSeq === null) firstSeq = appended.seq;
              lastSeq = appended.seq;
              this.journal.setTurnSpan(turnId, appended.seq);
              if (appended.inserted) publishAfterCommit.push(appended.record);
            }
            this.journal.setTurnTerminal(turnId, "completed", now);
            this.journal.putAppendReceipt({
              writerKey: receiptKey,
              fingerprint,
              firstSeq: firstSeq ?? lastSeq,
              lastSeq,
              epoch: this.journal.meta().epoch,
              createdAt: now,
            });
          });
        } catch (error) {
          appendFailure = error;
        }
      });
      if (finalResponse) return finalResponse;
      if (appendFailure) {
        if (appendFailure instanceof ConversationDeletedError) {
          return json(
            { code: "deleted", message: "This conversation was deleted." },
            410,
          );
        }
        log("error", "conversation_desktop_append_failed", {
          deviceId,
          localTurnId,
          message: errorMessage(appendFailure),
        });
        return json(
          {
            code: "append_failed",
            message: "Saving that to the cloud conversation failed. Try again.",
          },
          503,
        );
      }
      for (const record of publishAfterCommit) this.publish(record);
      void this.index
        .flush({ activity: "idle", updatedAt: now })
        .catch(() => undefined);
      // Rollover, at the one boundary this route can offer. `afterTerminal` used
      // to be its only trigger, so a conversation written only through here —
      // every desktop-mirrored conversation, once that trigger is wired — never
      // evaluated HOT_MAX_ROWS at all and grew with its lifetime writes. The
      // running-turn re-check is not redundant with the one above: the appends
      // between them yield, and rollover mid-turn is forbidden.
      if (!(await this.turnRunning())) {
        await this.archive.maybeRollover(Date.now());
      }
      return json({
        firstSeq: firstSeq ?? lastSeq,
        lastSeq,
        epoch: this.journal.meta().epoch,
        replayed: false,
      });
    } finally {
      await this.unregisterOwnerTurn(appendLease);
      if (this.ownerFencedAppends.get(appendLeaseId) === activeAppend) {
        this.ownerFencedAppends.delete(appendLeaseId);
      }
      settleAppend();
    }
  }

  /**
   * Oversize rows go to R2 rather than throwing a >2 MB INSERT. Assistant
   * messages are truncated instead of spilled: a placeholder for an assistant
   * message would drop its toolCall blocks and orphan every result that
   * follows, which is the one degradation the provider rejects outright.
   */
  protected async prepareOversize(
    role: MessageRole,
    message: AgentMessage,
    payloadJson: string,
    writerKey: string,
  ): Promise<{
    message: AgentMessage;
    payloadJson: string;
    spillKey?: string;
  }> {
    if (utf8Length(payloadJson) <= MAX_ROW_BYTES) {
      return { message, payloadJson };
    }
    if (role !== "assistant") {
      const spillKey = await this.archive
        .writeSpill(writerKey, payloadJson)
        .catch(() => null);
      if (spillKey) return { message, payloadJson, spillKey };
    }
    const truncated = truncateMessage(message, MAX_ROW_BYTES);
    const truncatedJson = JSON.stringify(truncated);
    if (utf8Length(truncatedJson) > MAX_ROW_BYTES) {
      throw new Error("Oversize message spill failed.");
    }
    return { message: truncated, payloadJson: truncatedJson };
  }

  /**
   * Cards written by the owner on a non-chat terminal (build, operation) and on
   * agent-thread completion (files). As journal rows they survive scrollback,
   * which an `agent_events` row inside a `take(100)` window never did.
   */
  protected async handleCard(request: Request): Promise<Response> {
    let body: {
      ownerId?: string;
      ownerGeneration?: string;
      sourceTurnId?: string;
      card?: ConversationCard;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "Malformed request." }, 400);
    }
    const sourceTurnId = body.sourceTurnId?.trim();
    const ownerId = body.ownerId?.trim();
    const ownerGeneration = body.ownerGeneration?.trim();
    const card = body.card;
    if (!ownerId || !ownerGeneration || !sourceTurnId || !card?.type) {
      return json({ error: "Malformed request." }, 400);
    }
    if (this.purged()) {
      return json({ error: "This conversation was deleted." }, 410);
    }
    // A build- or operation-only conversation reaches this handler having never
    // run an orchestrator turn, so `meta.owner_id` is still empty and an index
    // flush would be a no-op. Bind first (the caller is the owner, behind the
    // service secret): without it the row keeps `lastSeq` null and the orphan
    // sweep eventually deletes a conversation that has real content.
    try {
      const owner = await this.resolveOwnerForCaller(
        { ownerId },
        { refreshGeneration: true },
      );
      if (
        !owner ||
        owner.ownerId !== ownerId ||
        owner.ownerGeneration !== ownerGeneration
      ) {
        return json({ error: "Conversation generation is stale." }, 409);
      }
    } catch (error) {
      log("error", "conversation_card_owner_lookup_failed", {
        sourceTurnId,
        message: errorMessage(error),
      });
      return json({ error: "Conversation owner is unavailable." }, 409);
    }
    const writerKey = `card:${sourceTurnId}:${card.type}`;
    const payloadJson = JSON.stringify(card);
    const now = Date.now();
    if (utf8Length(payloadJson) > MAX_ROW_BYTES) {
      return json({ error: "Card payload is too large." }, 413);
    }
    try {
      // The owner lookup above yields, so the tombstone is re-read here for the
      // same reason the append route re-reads it.
      if (this.purged()) {
        return json({ error: "This conversation was deleted." }, 410);
      }
      if (await this.activeConversationEditLock()) {
        return json(
          {
            code: "conversation_edit_in_progress",
            message: "This conversation is being edited. Try again shortly.",
            retryAfterMs: 1_000,
          },
          409,
        );
      }
      if (await this.turnRunning()) {
        const size = this.journal.inboxSize();
        if (size.rows >= INBOX_MAX_ROWS || size.bytes >= INBOX_MAX_BYTES) {
          return json(
            {
              code: "inbox_full",
              message: "Stella is mid-reply — try again in a moment.",
              retryAfterMs: 5_000,
            },
            429,
          );
        }
        this.journal.stageInbox({
          writer: "service",
          writerKey,
          kind: "card",
          turnId: sourceTurnId,
          payloadJson,
          now,
        });
        return json({ staged: true });
      }
      const appended = this.journal.appendCard({
        turnId: sourceTurnId,
        writer: "service",
        writerKey,
        card,
        createdAt: now,
      });
      this.publish(appended.record);
      void this.index
        .flush({ activity: "idle", updatedAt: now })
        .catch(() => undefined);
      // Same reason as the journal route: a build- or operation-only
      // conversation runs no orchestrator turn, so this is the only place its
      // resident set is ever measured.
      if (!(await this.turnRunning())) {
        await this.archive.maybeRollover(Date.now());
      }
      return json({ seq: appended.seq });
    } catch (error) {
      log("error", "conversation_card_failed", {
        sourceTurnId,
        message: errorMessage(error),
      });
      return json({ error: "Recording that card failed." }, 503);
    }
  }

  /**
   * Tombstone, quiesce, snapshot, drain, then destroy — in that order and no
   * other. `deleteAll()` destroys the segment manifest, which is the only
   * record of the R2 keys; running it before the drain leaves the user's
   * deleted transcript in R2 forever with nothing left that can find it.
   *
   * The two middle steps are what make the snapshot complete rather than
   * merely current. A rollover or a spill that was already in flight when the
   * tombstone landed registers its key AFTER this handler would otherwise have
   * read the manifest — and an object named by nobody survives `deleteAll()`
   * with no per-conversation path left that can ever reach it. So: the
   * tombstone stops new writes starting, `quiesce()` waits out the ones
   * already running, and only then is the key list taken.
   *
   * Incomplete drains report `purged: false` and are retried by the owner
   * object's `conversations.purge` job (and its reset/delete purge hook)
   * rather than by a DO alarm: the alarm belongs to the turn lifecycle, and
   * borrowing it here would put a deletion bug inside the terminal-delivery
   * ladder. The 202 is load-bearing in `owner-store/purge.ts`, which reads
   * this body's `purged`, never the status class, precisely because
   * `response.ok` is true for it.
   */
  protected async handlePurge(): Promise<Response> {
    const now = Date.now();
    // Read before anything is destroyed: the deletion projection needs the
    // owner this object belonged to, and `deleteAll()` takes that with it.
    const identity = this.indexIdentity();
    this.journal.markDeleted(now);
    this.sealed = true;
    this.archive.seal();
    this.hub.closeAll(CLOSE_DELETED);
    await this.archive.quiesce();
    // `segments` and `spills` outlive the drain — only the queue rows are
    // removed — so what has already been offered has to be remembered here, or
    // the re-check below would re-delete every key on every purge.
    const enqueued = new Set<string>();
    const enqueueNewKeys = (): number => {
      const keys = [
        ...this.journal.allSegmentKeys(),
        ...this.journal.allSpillKeys(),
      ].filter((key) => !enqueued.has(key));
      for (const key of keys) enqueued.add(key);
      this.journal.enqueuePurge(keys, now);
      return keys.length;
    };
    enqueueNewKeys();
    let { pending } = await this.archive.drainPurge();
    // The drain itself awaits, and a tombstone is a fence rather than a lock.
    // Re-reading the manifest costs two queries and is what turns "nothing can
    // have been added behind us" from an argument into a check.
    if (pending === 0 && enqueueNewKeys() > 0) {
      pending = (await this.archive.drainPurge()).pending;
    }
    if (pending > 0) {
      log("error", "conversation_purge_incomplete", {
        conversationId: this.conversationId(),
        pending,
      });
      return json({ purged: false, pending }, 202);
    }
    const purgedId = this.conversationId();
    await this.ctx.storage.deleteAll();
    // The queue and its wake signal, explicitly and last.
    //
    // `deleteAll()` swept the queue that existed when this handler started; a
    // dispatch delivered while it was awaiting writes a fresh `queued:` key
    // behind it. In this isolate the seal drops that turn — but the seal is
    // in-memory, and a cold start after an eviction would re-enqueue it and run
    // a turn against the empty journal of a conversation the owner has already
    // recorded as deleted. Dropping the key is the durable half of the seal.
    //
    // The alarm goes with it rather than being left to `deleteAll()`: nothing
    // is queued any more, so there is no wake to guarantee, and an alarm
    // surviving here wakes a destroyed conversation on a timer for no work.
    const dropped: ChatTurnRequest[] = [];
    await this.ctx.blockConcurrencyWhile(async () => {
      const stragglers = await this.ctx.storage.list<ChatTurnRequest>({
        prefix: "queued:",
      });
      for (const [key, straggler] of stragglers) {
        dropped.push(straggler);
        await this.ctx.storage.delete(key);
      }
      await this.ctx.storage.deleteAlarm();
      if (stragglers.size > 0) {
        log("info", "conversation_purge_dropped_queued", {
          conversationId: this.ctx.id.name ?? "",
          dropped: stragglers.size,
        });
      }
    });
    for (const straggler of dropped) await this.releaseOwnerGate(straggler);
    // `deleteAll()` drops the tables, but THIS instance keeps serving: its
    // `Journal` was bootstrapped in the constructor and every method still
    // issues SQL. Without re-running the DDL the next request to reach this
    // object — a stale tab's socket upgrade, the dev probe, a retried sweep —
    // dies on `no such table: segments` and the worker answers 500 until the
    // platform happens to evict the object. Re-bootstrapping leaves an empty,
    // unbound journal; the in-memory seal is what keeps a stale tab from
    // adopting it, and the socket closes 4404 "That conversation no longer
    // exists."
    await this.journal.bootstrap();
    if (this.ctx.id.name) this.journal.setConversationId(this.ctx.id.name);
    if (identity) {
      // After the wipe, best-effort: The owner's own purge already tombstoned
      // the row before calling here; this closes the loop for a purge that
      // started on this side.
      await this.deferOwnerEvents([
        {
          ...this.ownerEventBase(identity, purgedId),
          kind: "conversation.deleted",
          conversationId: purgedId,
          deletedAt: now,
        } satisfies ConversationDeletedEvent,
      ]).catch(() => undefined);
    }
    log("info", "conversation_purged", { conversationId: purgedId });
    return json({ purged: true });
  }
}
