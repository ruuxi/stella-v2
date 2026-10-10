import {
  startTurnExecution,
  type TurnRetryCancellation,
} from "../turn-cancellation.js";
import type { JournalRecord } from "../conversation-types.js";
import {
  type LocalClientMessageReceipt,
  parseLocalTerminalPhase,
} from "../local-turn-protocol.js";
import type {
  ExactTurnCancellation,
  ExactTurnCancellationRequest,
} from "../execution-placement-turn-cancellation.js";
import type {
  ChatTurnRequest,
  LocalTurnLease,
  LocalTurnFinishReceipt,
  ChatTurnResumeRecord,
  OwedTerminal,
} from "./types.js";
import {
  CHAT_WATCHDOG_MS,
  CHAT_RESUME_MAX,
  CHAT_RESUME_MAX_AGE_MS,
  CHAT_RESUME_DEADLINE_MARGIN_MS,
  CHAT_TURN_RESUME_KEY,
  CHAT_TURN_STARTED_AT_KEY,
  LOCAL_TURN_CANCEL_GRACE_MS,
  LOCAL_TURN_LEASE_KEY,
  localTurnReceiptKey,
  localClientMessageKey,
  TERMINAL_NOTICE,
} from "./constants.js";
import {
  OwnerPurgeFenceError,
  localTurnRetirementDeadline,
  json,
  errorMessage,
  log,
} from "./support.js";
import { OrchestratorTurnLifecycle } from "./turn-lifecycle.js";

/**
 * The turn queue, exact cancellation, orphan resume, and desktop-local turn
 * leases.
 */
export abstract class OrchestratorTurnQueue extends OrchestratorTurnLifecycle {
  protected async cancelTurn(turnId: string): Promise<void> {
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease?.turnId === turnId) {
      await this.cancelLocalTurn(localLease);
      return;
    }
    const current = await this.ctx.storage.get<ChatTurnRequest>("turn");
    const queued = await this.ctx.storage.get<ChatTurnRequest>(
      `queued:${turnId}`,
    );
    const target = current?.turnId === turnId ? current : queued;
    if (!target) return;
    const response = await this.cancelExactChatTurn({
      turnId,
      cancelRequestId: `interactive:${turnId}`.slice(0, 128),
      ownerId: target.ownerId,
      ownerGeneration: target.ownerGeneration,
    });
    if (!response.ok) {
      throw new Error(
        `Exact turn cancellation failed with ${response.status}.`,
      );
    }
  }

  protected enqueue(
    turn: ChatTurnRequest,
    freshAdmission = false,
    options: { resume?: boolean } = {},
  ): void {
    if (this.turnExecutions.has(turn.turnId)) return;
    // Failures surface through the turn's own terminal event; the queue
    // must survive them.
    const preceding = this.queue;
    const enqueuedAt = performance.now();
    // This permit exists only in the admitting isolate and only for an idle
    // queue. Durable replays, alarms and queued work always revalidate remotely.
    const admission =
      freshAdmission && this.turnExecutions.size === 0 && !this.activeTurnId
        ? {
            leaseId: turn.ownerPurgeLeaseId,
            generation: turn.ownerPurgeGeneration,
            at: enqueuedAt,
          }
        : undefined;
    const execution = startTurnExecution({
      work: ({ cancellation, signal }) =>
        preceding.then(() =>
          this.runTurn(
            turn,
            cancellation,
            signal,
            enqueuedAt,
            admission,
            options.resume === true,
          ),
        ),
      onInterrupt: () => {
        // Before the run starts, the turn latch and the admission checks below
        // are authoritative.
        if (this.activeTurnId === turn.turnId) this.currentPiRun?.abort();
      },
    });
    this.turnExecutions.set(turn.turnId, execution);
    const clear = () => {
      this.cloudHomePreparations.delete(turn.turnId);
      this.admittedOwnerModelGrants.delete(turn.turnId);
      if (this.turnExecutions.get(turn.turnId) === execution) {
        this.turnExecutions.delete(turn.turnId);
      }
    };
    void execution.settled.then(clear, clear);
    this.queue = execution.settled.catch(() => undefined);
    this.ctx.waitUntil(this.queue);
  }

  /**
   * Exact placement Stop boundary. Target inspection and durable staging share
   * one critical section, so an unknown/queued turn cannot arrive later and run.
   * A current turn is acknowledged only after its exact execution promise has
   * settled; a newer current turn is never touched.
   */
  protected async cancelExactChatTurn(
    request: ExactTurnCancellationRequest,
  ): Promise<Response> {
    type Target =
      | { kind: "unknown" }
      | { kind: "queued"; turn: ChatTurnRequest }
      | {
          kind: "current";
          turn: ChatTurnRequest;
          terminalKind?: string;
        };
    type Admission =
      | { response: Response }
      | { staged: ExactTurnCancellation; target: Target };

    const admission = await this.ctx.blockConcurrencyWhile(
      async (): Promise<Admission> => {
        const current = await this.ctx.storage.get<ChatTurnRequest>("turn");
        const queued = await this.ctx.storage.get<ChatTurnRequest>(
          `queued:${request.turnId}`,
        );
        const exact = current?.turnId === request.turnId ? current : queued;
        if (
          exact &&
          (exact.ownerId !== request.ownerId ||
            exact.ownerGeneration !== request.ownerGeneration)
        ) {
          return {
            response: json(
              {
                canceled: false,
                reason: "stale_owner_generation",
                turnId: request.turnId,
              },
              409,
            ),
          };
        }

        let terminalKind: string | undefined;
        if (
          current?.turnId === request.turnId &&
          (await this.ctx.storage.get<boolean>("terminal"))
        ) {
          const owed = await this.ctx.storage.get<OwedTerminal | null>(
            "terminalOwed",
          );
          const journalState = this.journal.turnState(request.turnId);
          terminalKind =
            owed?.kind ??
            (journalState?.state === "terminal"
              ? (journalState.terminal_kind ?? undefined)
              : undefined);
          if (terminalKind !== "canceled") {
            return {
              response: json(
                {
                  canceled: false,
                  reason: "terminal_already_decided",
                  turnId: request.turnId,
                },
                409,
              ),
            };
          }
        }

        const result = await this.exactTurnCancellations.stage(request);
        if (result.status === "conflict") {
          return {
            response: json(
              {
                canceled: false,
                reason: "cancellation_identity_conflict",
                turnId: request.turnId,
              },
              409,
            ),
          };
        }
        if (result.status === "saturated") {
          return {
            response: json(
              {
                canceled: false,
                reason: "cancellation_ledger_saturated",
                turnId: request.turnId,
              },
              503,
            ),
          };
        }
        if (!("cancellation" in result)) {
          return {
            response: json(
              { canceled: false, reason: "cancellation_not_staged" },
              503,
            ),
          };
        }
        const target: Target =
          current?.turnId === request.turnId
            ? { kind: "current", turn: current, terminalKind }
            : queued
              ? { kind: "queued", turn: queued }
              : { kind: "unknown" };
        return { staged: result.cancellation, target };
      },
    );

    if ("response" in admission) return admission.response;
    const { staged, target } = admission;
    if (staged.state === "acknowledged") {
      return json({ canceled: true, turnId: request.turnId, replayed: true });
    }
    if (target.kind === "unknown" || target.kind === "queued") {
      return json(
        {
          canceled: true,
          turnId: request.turnId,
          pending: true,
          durable: true,
        },
        202,
      );
    }
    if (target.terminalKind === "canceled") {
      const execution = this.turnExecutions.get(request.turnId);
      if (this.activeTurnId === request.turnId && !execution) {
        return json(
          {
            canceled: false,
            reason: "exact_turn_join_unavailable",
            turnId: request.turnId,
          },
          503,
        );
      }
      if (execution) await execution.join();
      await this.acknowledgeExactTurnCancellation(request);
      return json({
        canceled: true,
        turnId: request.turnId,
        replayed: true,
        joined: true,
      });
    }
    return await this.cancelCurrentChatTurn(target.turn, request);
  }

  protected async acknowledgeExactTurnCancellation(
    request: ExactTurnCancellationRequest,
  ): Promise<boolean> {
    return await this.ctx.blockConcurrencyWhile(
      async () => await this.exactTurnCancellations.acknowledge(request),
    );
  }

  protected async cancelCurrentChatTurn(
    turn: ChatTurnRequest,
    request: ExactTurnCancellationRequest,
  ): Promise<Response> {
    const execution = this.turnExecutions.get(turn.turnId);
    if (this.activeTurnId === turn.turnId && !execution) {
      return json(
        {
          canceled: false,
          reason: "exact_turn_join_unavailable",
          turnId: turn.turnId,
        },
        503,
      );
    }
    const stored = await this.ctx.storage.get<ChatTurnRequest>("turn");
    if (
      !stored ||
      stored.turnId !== request.turnId ||
      stored.ownerId !== request.ownerId ||
      stored.ownerGeneration !== request.ownerGeneration
    ) {
      return json(
        {
          canceled: false,
          reason: "stale_turn",
          turnId: request.turnId,
          currentTurnId: stored?.turnId ?? null,
        },
        409,
      );
    }

    const exactTurn = { ...stored };
    try {
      exactTurn.ownerPurgeGeneration = await this.registerOwnerTurn(
        exactTurn,
        true,
      );
      await this.assertOwnerTurn(exactTurn);
      const owed: OwedTerminal = {
        kind: "canceled",
        message: TERMINAL_NOTICE.canceled,
        eventSeq: await this.nextTurnEventSeq(exactTurn.turnId),
      };
      await this.ctx.storage.put({ terminal: true, terminalOwed: owed });
      await execution?.interrupt(new Error("The chat turn was stopped."));
      await this.journalStoppedPrompt(exactTurn);
      this.recordTerminal(exactTurn, "canceled", TERMINAL_NOTICE.canceled);
      try {
        await this.emitTurnEvent(
          exactTurn,
          "canceled",
          { message: TERMINAL_NOTICE.canceled },
          {
            terminal: true,
            eventSeq: owed.eventSeq,
            errorMessage: TERMINAL_NOTICE.canceled,
          },
        );
        await this.ctx.storage.put("terminalDelivered", true);
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
      await this.finalizeTerminalTurn(exactTurn);
      if (execution) await execution.join();
      if (!(await this.acknowledgeExactTurnCancellation(request))) {
        throw new Error("Exact turn cancellation acknowledgement was lost.");
      }
      return json({
        canceled: true,
        turnId: request.turnId,
        joined: true,
      });
    } catch (error) {
      if (error instanceof OwnerPurgeFenceError) {
        return json(
          {
            canceled: false,
            reason: "owner_fence_closed",
            turnId: request.turnId,
          },
          409,
        );
      }
      throw error;
    } finally {
      await this.unregisterOwnerTurn(exactTurn);
    }
  }

  /**
   * On wake, the turn a replaced isolate was running (a deploy, an eviction)
   * and whether to resume it. Bounded: at most
   * {@link CHAT_RESUME_MAX} resumes per turn, counted durably here before the
   * resumed loop runs; only turns younger than {@link CHAT_RESUME_MAX_AGE_MS};
   * and only while the original watchdog, which a resume never extends,
   * leaves room. A refused turn is left exactly as before resume existed: the
   * watchdog times it out, or the next turn's admission fails it.
   *
   * `resume: false` is a turn lost before its prompt was journaled: it simply
   * runs again, still counted, still under its original watchdog.
   */
  protected async claimOrphanedTurnResume(): Promise<{
    turn: ChatTurnRequest;
    resume: boolean;
  } | null> {
    const turn = await this.getTurnState<ChatTurnRequest>("turn");
    if (!turn) return null;
    const [terminal, delivered, watchdogAt, startedAt, record, queued] =
      await Promise.all([
        this.getTurnState<boolean>("terminal"),
        this.getTurnState<boolean>("terminalDelivered"),
        this.getTurnState<number>("turnWatchdogAt"),
        this.getTurnState<number>(CHAT_TURN_STARTED_AT_KEY),
        this.getTurnState<ChatTurnResumeRecord | null>(CHAT_TURN_RESUME_KEY),
        this.getTurnState<ChatTurnRequest>(`queued:${turn.turnId}`),
      ]);
    // A still-queued copy means the claim itself was interrupted; the queue
    // replay below runs it from the top.
    if (terminal || delivered || queued) return null;
    if (this.journal.turnState(turn.turnId)?.state === "terminal") return null;
    const now = Date.now();
    const resumeCount = record?.turnId === turn.turnId ? record.count : 0;
    const claimedAt =
      startedAt ??
      (typeof watchdogAt === "number"
        ? watchdogAt - Math.max(1_000, turn.watchdogMs ?? CHAT_WATCHDOG_MS)
        : undefined);
    const ageMs =
      claimedAt === undefined ? Number.POSITIVE_INFINITY : now - claimedAt;
    const refusal =
      resumeCount >= CHAT_RESUME_MAX
        ? "resume_cap"
        : ageMs >= CHAT_RESUME_MAX_AGE_MS
          ? "too_old"
          : typeof watchdogAt !== "number" ||
              watchdogAt - now <= CHAT_RESUME_DEADLINE_MARGIN_MS
            ? "watchdog"
            : undefined;
    if (refusal) {
      log("info", "chat_turn_not_resumable", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        reason: refusal,
        resumeCount,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
      });
      return null;
    }
    const count = resumeCount + 1;
    await this.putTurnState({
      [CHAT_TURN_RESUME_KEY]: {
        turnId: turn.turnId,
        count,
      } satisfies ChatTurnResumeRecord,
    });
    const promptJournaled = this.journal.hasRow(`turn:${turn.turnId}:prompt`);
    log("info", "chat_turn_resumed", {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      resumeCount: count,
      promptJournaled,
      ageMs,
    });
    return { turn, resume: promptJournaled };
  }

  protected async queuedTurns(): Promise<ChatTurnRequest[]> {
    const queued = await this.ctx.storage.list<ChatTurnRequest>({
      prefix: "queued:",
    });
    return [...queued.values()].sort(
      (left, right) =>
        (left.queuedAt ?? Number.MAX_SAFE_INTEGER) -
          (right.queuedAt ?? Number.MAX_SAFE_INTEGER) ||
        left.turnId.localeCompare(right.turnId),
    );
  }

  protected async withTurnAdmissionLock<T>(work: () => Promise<T>): Promise<T> {
    const preceding = this.turnAdmissionTail;
    let release!: () => void;
    this.turnAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await work();
    } finally {
      release();
    }
  }

  protected async restoreLocalLease(lease: LocalTurnLease): Promise<void> {
    this.live = {
      turnId: lease.turnId,
      streamId: null,
      partialText: "",
      tools: [],
    };
    if (
      lease.cancelRequested &&
      (!Number.isFinite(lease.cancelDeadlineAt) || lease.cancelDeadlineAt! <= 0)
    ) {
      // A deployment-era or crash-recovered cancellation without a deadline
      // gets a full new desktop ACK grace. It must never fall back to the
      // older provider lease expiry and retire immediately.
      lease.cancelDeadlineAt = Date.now() + LOCAL_TURN_CANCEL_GRACE_MS;
      await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, lease);
    }
    const retirementAt = localTurnRetirementDeadline(lease);
    const alarmAt = await this.ctx.storage.getAlarm();
    if (
      lease.cancelRequested
        ? alarmAt !== retirementAt
        : alarmAt === null || alarmAt > retirementAt
    ) {
      await this.ctx.storage.setAlarm(retirementAt);
    }
  }

  protected async armLocalLeaseAlarm(expiresAt: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.armAlarmNoLaterThan(expiresAt);
    });
  }

  protected async storeLocalTurnReceipt(
    lease: LocalTurnLease,
    receipt: LocalTurnFinishReceipt,
  ): Promise<void> {
    const records: Record<string, unknown> = {
      [localTurnReceiptKey(lease.turnId)]: receipt,
    };
    if (lease.clientMsgId) {
      records[localClientMessageKey(lease.clientMsgId)] = {
        ownerGeneration: lease.ownerGeneration,
        clientMsgId: lease.clientMsgId,
        beginFingerprint: lease.beginFingerprint,
        turnId: lease.turnId,
        phase: receipt.phase,
      } satisfies LocalClientMessageReceipt;
    }
    await this.ctx.storage.put(records);
  }

  protected async cancelLocalTurn(
    lease: LocalTurnLease,
    forceRelease = false,
  ): Promise<boolean> {
    let claimed: LocalTurnLease | undefined;
    let terminalRecord: JournalRecord | undefined;
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        !current ||
        current.turnId !== lease.turnId ||
        current.leaseToken !== lease.leaseToken
      ) {
        return;
      }
      const state = this.journal.turnState(current.turnId);
      const wasExternallyCanceled = current.cancelRequested === true;
      current.cancelRequested = true;
      if (
        !Number.isFinite(current.cancelDeadlineAt) ||
        current.cancelDeadlineAt! <= 0
      ) {
        current.cancelDeadlineAt = Date.now() + LOCAL_TURN_CANCEL_GRACE_MS;
      }
      const cancelDeadlineAt = current.cancelDeadlineAt!;
      await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, current);
      // Replace (rather than retain) an earlier watchdog. alarm() must never
      // interpret an unrelated/old alarm as the end of the desktop ACK grace.
      await this.ctx.storage.setAlarm(cancelDeadlineAt);

      let phase =
        state?.state === "terminal"
          ? (parseLocalTerminalPhase(state.terminal_kind) ?? "canceled")
          : "canceled";
      let terminalSeq = this.journal.head("idle").headSeq;
      let externallyCanceled = wasExternallyCanceled;
      if (state?.state !== "terminal") {
        const now = Date.now();
        const terminal = this.journal.appendTurn({
          turnId: current.turnId,
          writer: `desktop:${current.deviceId}`,
          writerKey: `turn:${current.turnId}:phase:canceled`,
          phase: "canceled",
          lane: "chat",
          source: "desktop",
          notice: TERMINAL_NOTICE.canceled,
          createdAt: now,
        });
        terminalSeq = terminal.seq;
        terminalRecord = terminal.record;
        phase = "canceled";
        externallyCanceled = true;
        this.journal.setTurnSpan(current.turnId, terminal.seq);
        this.journal.setTurnTerminal(current.turnId, "canceled", now);
      }
      const receipt: LocalTurnFinishReceipt = {
        ownerGeneration: current.ownerGeneration,
        turnId: current.turnId,
        deviceId: current.deviceId,
        localTurnId: current.localTurnId,
        leaseToken: current.leaseToken,
        phase,
        firstSeq: terminalSeq,
        lastSeq: terminalSeq,
        epoch: this.journal.meta().epoch,
        ...(externallyCanceled
          ? { externallyCanceled: true }
          : current.finishFingerprint
            ? { finishFingerprint: current.finishFingerprint }
            : {}),
      };
      await this.storeLocalTurnReceipt(current, receipt);
      claimed = current;
    });
    if (!claimed) return false;
    if (terminalRecord) this.publish(terminalRecord);
    this.live = null;
    this.hub.endTurn(claimed.turnId);
    // Keep the single-writer fence during a short cancellation handshake.
    // The desktop runtime's control heartbeat observes the terminal receipt,
    // aborts its provider, and replays a canceled finish, whose receipt path
    // releases immediately. If the desktop is gone, the alarm force-releases
    // after the bounded grace instead of admitting conflicting work at the
    // instant another client presses Stop.
    if (forceRelease) {
      await this.unregisterOwnerTurn(claimed);
      await this.releaseLocalLeaseAndResume(claimed);
    }
    const now = Date.now();
    await this.index
      .flush({ activity: "idle", updatedAt: now })
      .catch(() => undefined);
    try {
      this.drainInbox();
    } catch (error) {
      log("error", "conversation_local_turn_cancel_drain_failed", {
        turnId: claimed.turnId,
        message: errorMessage(error),
      });
    }
    await this.archive.maybeRollover(now).catch((error) => {
      log("error", "conversation_local_turn_cancel_rollover_failed", {
        turnId: claimed!.turnId,
        message: errorMessage(error),
      });
    });
    return true;
  }

  protected async releaseLocalLeaseAndResume(
    lease: LocalTurnLease,
    resumeQueued = true,
  ): Promise<void> {
    let queued: ChatTurnRequest[] = [];
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        !current ||
        current.turnId !== lease.turnId ||
        current.leaseToken !== lease.leaseToken
      ) {
        return;
      }
      await this.ctx.storage.delete(LOCAL_TURN_LEASE_KEY);
      if (resumeQueued) {
        queued = await this.queuedTurns();
        if (queued.length === 0) {
          if (await this.hasMaintenanceDebt()) {
            const retryAt = Date.now() + 30_000;
            await this.armAlarmNoLaterThan(retryAt);
          } else {
            await this.ctx.storage.deleteAlarm().catch(() => undefined);
          }
        }
      }
    });
    for (const turn of queued) this.enqueue(turn);
    if (queued.length > 0) await this.ensureQueueAlarm();
  }

  /**
   * The wake guarantee, made true rather than nearly true: for as long as any
   * turn is durable under `queued:`, this object has a pending alarm.
   *
   * `/turn` establishes it; every path that ENDS an alarm has to restore it.
   * Firing is one of those paths — Cloudflare consumes the alarm when it
   * delivers it and never re-arms — so a watchdog that fires while a second
   * turn sits queued leaves that turn with no wake signal at all. The
   * in-memory queue still drains it, right up until the isolate is evicted;
   * after that nothing in Cloudflare ever wakes this object on its
   * own, and a turn that was accepted with a 202 and an `agent_turns` row
   * reading "running" is stranded until a user happens to open the
   * conversation, which may be days later or never.
   *
   * Arms only when nothing is pending, and never deletes: a live watchdog or a
   * 30 s terminal-delivery rung must not be shortened or dropped by a call to
   * this. The critical section is what makes the read and the write one step
   * against `/turn` and against the completed path's `deleteAlarm`.
   */
  protected async ensureQueueAlarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.getAlarm()) !== null) return;
      const queued = await this.ctx.storage.list<ChatTurnRequest>({
        prefix: "queued:",
        limit: 1,
      });
      const next = [...queued.values()][0];
      if (!next) return;
      await this.ctx.storage.setAlarm(
        Date.now() + Math.max(1_000, next.watchdogMs ?? CHAT_WATCHDOG_MS),
      );
      log("info", "chat_queue_alarm_rearmed", {
        turnId: next.turnId,
        conversationId: next.conversationId,
      });
    });
  }

  protected async expireLocalLease(
    lease: LocalTurnLease,
    resumeQueued: boolean,
  ): Promise<void> {
    const current =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (
      !current ||
      current.turnId !== lease.turnId ||
      current.leaseToken !== lease.leaseToken
    ) {
      return;
    }
    const priorState = this.journal.turnState(lease.turnId);
    const phase =
      priorState?.state === "terminal"
        ? (parseLocalTerminalPhase(priorState.terminal_kind) ?? "timeout")
        : "timeout";
    let terminalSeq = this.journal.head("idle").headSeq;
    try {
      if (priorState?.state !== "terminal") {
        const now = Date.now();
        const row = this.journal.appendTurn({
          turnId: lease.turnId,
          writer: `desktop:${lease.deviceId}`,
          writerKey: `turn:${lease.turnId}:phase:timeout`,
          phase: "timeout",
          lane: "chat",
          source: "desktop",
          notice: TERMINAL_NOTICE.timeout,
          createdAt: now,
        });
        terminalSeq = row.seq;
        this.journal.setTurnSpan(lease.turnId, row.seq);
        this.journal.setTurnTerminal(lease.turnId, "timeout", now);
        this.publish(row.record);
      }
    } catch (error) {
      log("error", "conversation_local_turn_timeout_failed", {
        turnId: lease.turnId,
        message: errorMessage(error),
      });
      throw error;
    }
    const receipt: LocalTurnFinishReceipt = {
      ownerGeneration: lease.ownerGeneration,
      turnId: lease.turnId,
      deviceId: lease.deviceId,
      localTurnId: lease.localTurnId,
      leaseToken: lease.leaseToken,
      phase,
      firstSeq: terminalSeq,
      lastSeq: terminalSeq,
      epoch: this.journal.meta().epoch,
    };
    await this.storeLocalTurnReceipt(lease, receipt);
    await this.unregisterOwnerTurn(lease);
    await this.releaseLocalLeaseAndResume(lease, resumeQueued);
    this.live = null;
    this.hub.endTurn(lease.turnId);
    const now = Date.now();
    await this.index
      .flush({ activity: "idle", updatedAt: now })
      .catch(() => undefined);
    try {
      this.drainInbox();
    } catch (error) {
      log("error", "conversation_local_turn_timeout_drain_failed", {
        turnId: lease.turnId,
        message: errorMessage(error),
      });
    }
    await this.archive.maybeRollover(now).catch((error) => {
      log("error", "conversation_local_turn_timeout_rollover_failed", {
        turnId: lease.turnId,
        message: errorMessage(error),
      });
    });
  }

  // Implemented by `OrchestratorRunTurn`.
  protected abstract runTurn(
    turn: ChatTurnRequest,
    turnCancellation: TurnRetryCancellation,
    executionSignal: AbortSignal,
    enqueuedAt?: number,
    admission?: {
      leaseId: string | undefined;
      generation: string | undefined;
      at: number;
    },
    resumeTurn?: boolean,
  ): Promise<Response>;
}
