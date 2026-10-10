import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import { assistantMessageHasUsableOutput } from "@stella/runtime/kernel/agent-runtime/run-shared.js";
import type { TurnEventEvent } from "@stella/contracts/turn-plane/owner-events";
import { deliverOwnerEvents } from "../owner-events.js";
import { unwrapRpc } from "../owner-store/errors.js";
import {
  CONTEXT_MAX_SPILL_HYDRATIONS,
  type ConversationCard,
  MAX_ROW_BYTES,
  type MessageRole,
  type TurnPhase,
  utf8Length,
} from "../conversation-types.js";
import { Journal } from "../journal.js";
import type { ChatTurnRequest, LocalTurnLease, OwedTerminal } from "./types.js";
import {
  LOCAL_TURN_LEASE_KEY,
  turnEventSeqKey,
  TERMINAL_STATUS,
} from "./constants.js";
import {
  json,
  errorMessage,
  log,
  base64FromBytes,
  truncateMessage,
  terminalNotice,
} from "./support.js";
import { OrchestratorOwner } from "./owner.js";

/** Turn events, produced rows, terminal recording, and the card inbox. */
export abstract class OrchestratorTurnLifecycle extends OrchestratorOwner {
  /**
   * The next per-turn event ordinal, durable before it is used so a restart
   * can never hand out one twice. Serialized: two events of one turn can be
   * emitted concurrently and share the same get+put window otherwise.
   */
  protected nextTurnEventSeq(turnId: string): Promise<number> {
    const tail: Promise<unknown> = this.eventSeqTail ?? Promise.resolve();
    const work = tail.then(async () => {
      const key = turnEventSeqKey(turnId);
      const next = ((await this.getTurnState<number>(key)) ?? 0) + 1;
      await this.putTurnState({ [key]: next });
      return next;
    });
    this.eventSeqTail = work.catch(() => undefined);
    return work;
  }

  /**
   * One `turn.event` for the owner. Terminal events commit to a local
   * durable batch before returning, independently of the owner's availability.
   * Each batch survives a newer turn replacing terminalOwed; its alarm owns
   * delivery retries. The original ordinal keeps redelivery idempotent.
   */
  protected async emitTurnEvent(
    turn: ChatTurnRequest,
    eventKind: string,
    payload: unknown,
    options: {
      terminal?: boolean;
      eventSeq?: number;
      errorMessage?: string;
      resultJson?: string;
      deferred?: boolean;
    } = {},
  ): Promise<number> {
    const eventSeq =
      options.eventSeq ?? (await this.nextTurnEventSeq(turn.turnId));
    const event = this.turnEvent(turn, eventKind, payload, eventSeq, options);
    if (options.deferred || event.terminal)
      await this.deferOwnerEvents([event]);
    else await deliverOwnerEvents(this.env, [event]);
    return eventSeq;
  }

  protected turnEvent(
    turn: ChatTurnRequest,
    eventKind: string,
    payload: unknown,
    eventSeq: number,
    options: { terminal?: boolean; errorMessage?: string; resultJson?: string },
  ): TurnEventEvent {
    const terminal = options.terminal === true;
    return {
      ...this.ownerEventBase(turn, `${turn.turnId}:${eventSeq}`),
      kind: "turn.event",
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      eventSeq,
      eventKind,
      payload,
      terminal,
      ...(terminal
        ? { terminalStatus: TERMINAL_STATUS[eventKind] ?? "failed" }
        : {}),
      ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
      ...(options.resultJson ? { resultJson: options.resultJson } : {}),
      createdAt: Date.now(),
    };
  }

  /** The terminal ordinal, assigned once and remembered with the debt. */
  protected async terminalEventSeq(
    turn: ChatTurnRequest,
    owed: OwedTerminal,
  ): Promise<number> {
    if (owed.eventSeq !== undefined) return owed.eventSeq;
    const eventSeq = await this.nextTurnEventSeq(turn.turnId);
    owed.eventSeq = eventSeq;
    await this.ctx.storage.put("terminalOwed", owed);
    return eventSeq;
  }

  /**
   * What this turn still owes the owner, for a caller that did not terminate it
   * itself. `terminalOwed` is the authority — it is written in the same durable
   * put as `terminal` by every path that terminates a turn. The journal's
   * recorded kind is the fallback, and covers exactly one case: a turn that
   * went terminal under a build that predates the key.
   */
  protected async owedTerminal(
    turn: ChatTurnRequest,
  ): Promise<OwedTerminal | null> {
    const owed = await this.ctx.storage.get<OwedTerminal | null>(
      "terminalOwed",
    );
    if (owed) return owed;
    if (!(await this.ctx.storage.get<boolean>("terminal"))) return null;
    const recorded = this.journal.turnState(turn.turnId);
    const kind =
      recorded?.state === "terminal" && recorded.terminal_kind
        ? recorded.terminal_kind
        : "failed";
    return { kind: kind as TurnPhase, message: terminalNotice(kind) };
  }

  /**
   * The completed terminal, shared by Stella's own loop and a Claude Code
   * turn: everything the turn produced is already journaled.
   */
  protected async completeChatTurn(
    turn: ChatTurnRequest,
    finalText: string,
    started: number,
  ): Promise<Response> {
    const wallClockMs = Math.round(performance.now() - started);
    // `terminal` and what is owed, in ONE durable write BEFORE delivery —
    // the same ordering the cancel and failed paths use. The watchdog reads
    // `terminal` to decide whether a turn is still owed one, so writing it
    // after the owner round trip left a window (widened by the retry
    // ladder, which pushes completions toward the deadline) where an alarm
    // firing mid-delivery declared a finished turn timed out, and clients
    // group on the last row per turn — so the user saw "timed out" over a
    // reply that had actually arrived.
    const completedOwed: OwedTerminal = {
      kind: "completed",
      message: "",
      payload: { text: finalText, wallClockMs },
      eventSeq: await this.nextTurnEventSeq(turn.turnId),
    };
    await this.ctx.storage.put({
      terminal: true,
      terminalOwed: completedOwed,
    });
    this.recordTerminal(turn, "completed", undefined, wallClockMs);
    try {
      await this.emitTurnEvent(
        turn,
        "completed",
        { text: finalText, wallClockMs },
        {
          terminal: true,
          eventSeq: completedOwed.eventSeq,
          resultJson: JSON.stringify({ finalText }),
        },
      );
      await this.ctx.storage.put("terminalDelivered", true);
    } catch {
      // Same pairing as the other terminal paths: the re-armed alarm
      // redelivers exactly what `terminalOwed` says is owed, reply text
      // included, instead of stranding a completed turn as "running".
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
    await this.afterTerminal(turn);
    // Keep the alarm alive while queued turns remain: it is the wake
    // guarantee that lets a restarted DO drain the durable queue. The read
    // and the delete are one step against `/turn`'s enqueue — otherwise a
    // turn accepted between them is left durable under `queued:` with the
    // alarm it was promised already deleted.
    await this.ctx.blockConcurrencyWhile(async () => {
      const queued = await this.ctx.storage.list({
        prefix: "queued:",
        limit: 1,
      });
      if (queued.size === 0) {
        if (
          !(await this.getTurnState<boolean>("terminalDelivered")) ||
          (await this.hasMaintenanceDebt())
        ) {
          const retryAt = Date.now() + 30_000;
          await this.armAlarmNoLaterThan(retryAt);
        } else {
          await this.ctx.storage.deleteAlarm();
        }
      }
    });
    log("info", "chat_turn_completed", {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      wallClockMs: Math.round(performance.now() - started),
    });
    return json({ ok: true, text: finalText });
  }

  /**
   * Hydrate the turn's attached drive images into image content blocks. The
   * owner's object signs only its own images, image-typed and size-capped,
   * under the turn's owner generation. Failure of any piece degrades to a
   * turn without pixels — the prompt text still names the paths.
   */
  protected async loadChatAttachmentImages(
    turn: ChatTurnRequest,
    signal?: AbortSignal,
  ): Promise<ImageContent[]> {
    const paths = (turn.attachments ?? []).slice(0, 4);
    if (paths.length === 0) return [];
    try {
      signal?.throwIfAborted();
      const payload = unwrapRpc(
        await this.ownerGate(turn.ownerId).ownerInternal({
          name: "drive.turnAttachments",
          args: { paths },
          ownerGeneration: turn.ownerGeneration,
        }),
      ) as {
        attachments?: Array<{ path: string; contentType: string; url: string }>;
      };
      signal?.throwIfAborted();
      const images: ImageContent[] = [];
      for (const entry of payload.attachments ?? []) {
        try {
          signal?.throwIfAborted();
          const bytes = await fetch(entry.url, {
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
              : AbortSignal.timeout(20_000),
          });
          signal?.throwIfAborted();
          if (!bytes.ok) continue;
          const content = new Uint8Array(await bytes.arrayBuffer());
          signal?.throwIfAborted();
          images.push({
            type: "image",
            data: base64FromBytes(content),
            mimeType: entry.contentType,
          });
        } catch {
          signal?.throwIfAborted();
          // One unreadable attachment must not cost the others.
        }
      }
      return images;
    } catch (error) {
      signal?.throwIfAborted();
      log("error", "chat_attachment_hydration_failed", {
        turnId: turn.turnId,
        message: errorMessage(error),
      });
      return [];
    }
  }

  /**
   * The conversation's reply-language locale: a turn that carries one
   * updates the stored value; turns without one (schedule fires,
   * agent-completion wakes) reuse it, so the language never flips back to
   * English mid-conversation.
   */
  protected async resolveTurnLocale(
    turn: ChatTurnRequest,
    assertActive?: () => void,
  ): Promise<string | undefined> {
    assertActive?.();
    try {
      const carried = turn.locale?.trim();
      if (carried && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(carried)) {
        const stored = await this.ctx.storage.get<string>("locale");
        assertActive?.();
        if (stored !== carried) {
          assertActive?.();
          await this.ctx.storage.put("locale", carried);
          assertActive?.();
        }
        return carried;
      }
      const stored = await this.ctx.storage.get<string>("locale");
      assertActive?.();
      return stored;
    } catch {
      assertActive?.();
      return undefined;
    }
  }

  protected bindConversation(turn: ChatTurnRequest): void {
    this.journal.setConversationId(turn.conversationId);
    const meta = this.journal.meta();
    if (!meta.owner_id) {
      this.journal.bindOwner({
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        createdAt: turn.queuedAt ?? Date.now(),
        title: turn.title ?? "",
        conversationId: turn.conversationId,
      });
    } else if (meta.owner_id !== turn.ownerId) {
      throw new Error("This conversation belongs to a different owner.");
    }
    if (turn.title) this.journal.setTitle(turn.title);
  }

  /**
   * Journal one produced message without publishing it, so a caller can
   * commit several rows (and its own cursor) in one transaction first. Null
   * when the message is never journaled.
   */
  protected appendProduced(
    turn: ChatTurnRequest,
    message: AgentMessage,
    target: { writer: string; writerKey: string; streamId: string | null },
  ): ReturnType<Journal["appendMessage"]> | null {
    const { streamId } = target;
    const role = (message as { role?: string }).role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult")
      return null;
    // An assistant message with no usable output is never persisted: ONE such
    // row poisons every future Anthropic request for this conversation. The
    // predicate is the retry ladder's own — a message it would pop from the
    // live context on resume must never have reached the journal, or the
    // transcript keeps a reply the model no longer has and the next turn
    // rebuilds history with two consecutive assistant messages. This covers
    // the errored placeholder (empty text) and the thinking-only completion
    // that hit the output cap while reasoning.
    if (!assistantMessageHasUsableOutput(message)) return null;
    let stored = message;
    let payloadJson = JSON.stringify(message);
    if (utf8Length(payloadJson) > MAX_ROW_BYTES) {
      // No R2 round trip is available here: the Agent's event sink drops
      // returned promises, so an oversize loop row is truncated in place with
      // an explicit marker rather than silently lost. Nothing in the pinned
      // tool set can currently produce a message this large.
      stored = truncateMessage(message, MAX_ROW_BYTES);
      payloadJson = JSON.stringify(stored);
      log("error", "conversation_row_truncated", {
        turnId: turn.turnId,
        role,
        bytes: utf8Length(JSON.stringify(message)),
      });
    }
    const appended = this.journal.appendMessage({
      turnId: turn.turnId,
      writer: target.writer,
      writerKey: target.writerKey,
      role: role as MessageRole,
      message: stored,
      payloadJson,
      ...(role === "assistant" && streamId ? { streamId } : {}),
    });
    this.journal.setTurnSpan(turn.turnId, appended.seq);
    return appended;
  }

  /**
   * Pulls back what the window needs from R2, and degrades the rest honestly.
   * A tool result keeps its `toolCallId` through the degradation so it never
   * orphans the call it answers.
   */
  protected async hydrateWindow(
    selection: ReturnType<Journal["selectWindow"]>,
  ): Promise<AgentMessage[]> {
    if (selection.spilled.length === 0) return selection.messages;
    const messages = selection.messages.slice();
    const now = Date.now();
    let hydrated = 0;
    // Newest first: the most recent oversize payload is the one the model is
    // most likely to need.
    for (const entry of [...selection.spilled].reverse()) {
      if (hydrated < CONTEXT_MAX_SPILL_HYDRATIONS) {
        const payload = await this.archive
          .readSpill(entry.spillKey)
          .catch(() => null);
        if (payload) {
          messages[entry.index] = payload as AgentMessage;
          hydrated += 1;
          continue;
        }
      } else {
        // Over budget, permanently: stop paying to consider this row again.
        this.journal.markModelSkip(entry.seq);
      }
      messages[entry.index] = this.journal.omittedPlaceholder(
        entry.role,
        now,
        entry.toolCallId,
      );
    }
    return messages;
  }

  /**
   * The transcript's copy of a terminal state. Idempotent by writer key and
   * never throwing: it is a projection of the `terminal` / `terminalDelivered`
   * storage keys, which remain the authority, and a failure here must not be
   * able to disturb the delivery ladder that owns them.
   */
  protected recordTerminal(
    turn: ChatTurnRequest,
    phase: TurnPhase,
    notice?: string,
    wallClockMs?: number,
  ): void {
    try {
      const now = Date.now();
      const row = this.journal.appendTurn({
        turnId: turn.turnId,
        writer: "orchestrator",
        writerKey: `turn:${turn.turnId}:phase:${phase}`,
        phase,
        lane: turn.lane ?? "chat",
        source: turn.source,
        notice,
        wallClockMs,
        createdAt: now,
      });
      this.journal.setTurnSpan(turn.turnId, row.seq);
      this.journal.setTurnTerminal(turn.turnId, phase, now);
      this.publish(row.record);
    } catch (error) {
      log("error", "conversation_terminal_record_failed", {
        turnId: turn.turnId,
        phase,
        message: errorMessage(error),
      });
    } finally {
      this.live = null;
      this.hub.endTurn(turn.turnId);
    }
  }

  /**
   * Everything that must happen after a turn is terminal, and that must never
   * be able to make a delivered turn look failed. Rollover in particular runs
   * only here: never mid-turn, never on a read path.
   *
   * Reached from EVERY terminal path, not just the completed one. A canceled
   * or timed-out turn still owes an index update and inbox drain. Callers that
   * are not the loop must go through `finalizeTerminalTurn`.
   */
  protected async afterTerminal(turn: ChatTurnRequest): Promise<void> {
    this.finalizedTurnId = turn.turnId;
    const now = Date.now();
    const indexAt = performance.now();
    await this.index
      .flush({ activity: "idle", updatedAt: now })
      .catch(() => undefined);
    const drainAt = performance.now();
    try {
      this.drainInbox();
    } catch (error) {
      // The per-row failures are already handled inside; this covers the
      // enclosing reads. Nothing here may throw: the alarm calls this too, and
      // a rejection there re-runs the whole watchdog handler.
      log("error", "conversation_inbox_drain_aborted", {
        turnId: turn.turnId,
        message: errorMessage(error),
      });
    }
    const rolloverAt = performance.now();
    await this.archive.maybeRollover(now);
    log("info", "chat_turn_maintenance", {
      turnId: turn.turnId,
      indexFlushMs: Math.round(drainAt - indexAt),
      inboxMs: Math.round(rolloverAt - drainAt),
      rolloverMs: Math.round(performance.now() - rolloverAt),
    });
  }

  /**
   * `afterTerminal` for a caller that is not the loop — the watchdog and
   * `/cancel`. It skips a turn it has already finalized, so a retrying alarm
   * does not re-cut segments.
   *
   * The inbox drain and rollover wait for the loop. Draining here could splice
   * a foreign row between a tool call and its result, and rollover mid-turn is
   * forbidden outright.
   */
  protected async finalizeTerminalTurn(turn: ChatTurnRequest): Promise<void> {
    if (this.finalizedTurnId === turn.turnId) return;
    if (this.activeTurnId === turn.turnId) return;
    await this.afterTerminal(turn);
  }

  protected async turnRunning(): Promise<boolean> {
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease) return true;
    const [turn, queued] = await Promise.all([
      this.ctx.storage.get<ChatTurnRequest>("turn"),
      this.ctx.storage.list<ChatTurnRequest>({
        prefix: "queued:",
        limit: 1,
      }),
    ]);
    if (queued.size > 0) return true;
    if (!turn) return false;
    return !(await this.ctx.storage.get<boolean>("terminal"));
  }

  /**
   * Moves staged foreign rows into the journal at a clean boundary. Every row
   * is dropped from the inbox whether or not it applied, so a poison row can
   * never wedge the drain.
   */
  protected drainInbox(): void {
    for (;;) {
      const rows = this.journal.takeInbox(50);
      if (rows.length === 0) return;
      for (const row of rows) {
        try {
          if (row.kind === "card") {
            this.publish(
              this.journal.appendCard({
                turnId: row.turn_id,
                writer: row.writer,
                writerKey: row.writer_key,
                card: JSON.parse(row.payload_json) as ConversationCard,
                createdAt: row.created_at,
              }).record,
            );
          } else if (row.kind === "turn") {
            const detail = JSON.parse(row.payload_json) as {
              phase: TurnPhase;
              lane?: string;
              source?: string;
              notice?: string;
            };
            this.publish(
              this.journal.appendTurn({
                turnId: row.turn_id,
                writer: row.writer,
                writerKey: row.writer_key,
                phase: detail.phase,
                lane: detail.lane,
                source: detail.source,
                notice: detail.notice,
                createdAt: row.created_at,
              }).record,
            );
          } else {
            this.publish(
              this.journal.appendMessage({
                turnId: row.turn_id,
                writer: row.writer,
                writerKey: row.writer_key,
                role: (row.role ?? "user") as MessageRole,
                hidden: row.hidden === 1,
                message: JSON.parse(row.payload_json) as AgentMessage,
                payloadJson: row.payload_json,
                createdAt: row.created_at,
              }).record,
            );
          }
        } catch (error) {
          log("error", "conversation_inbox_drain_failed", {
            writerKey: row.writer_key,
            message: errorMessage(error),
          });
        } finally {
          this.journal.dropInbox(row.id);
        }
      }
    }
  }
}
