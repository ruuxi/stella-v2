import type {
  AdmittedCloudChat,
  CloudChatPreparation,
} from "./cloud-chat-admission.js";
import type { OwnerModelGrantFreezeRequest } from "./owner-model-grants.js";
import {
  type CloudTurnStartRequest,
  TURN_OWNER_GENERATION_HEADER,
} from "@stella/contracts/turn-plane/turn-start";
import { HEADER_TURN_AUTH_KIND } from "./turn-start-request.js";
import { JOURNAL_CHECKPOINT_PATH } from "@stella/contracts/journal-checkpoint";
import { HEADER_OWNER, parseSocketIdentity } from "./conversation-types.js";
import { CLOUD_CLI_TURN_DO_PATHS } from "@stella/contracts/cloud-orchestrator-cli";
import { parseExactTurnCancellationRequest } from "./execution-placement-turn-cancellation.js";
import type {
  ChatTurnRequest,
  OwnerFencedTurn,
  OwnerFenceLeaseReceipt,
  LocalTurnLease,
  LocalTurnFinishReceipt,
} from "./orchestrator/types.js";
import {
  AGENT_RUNTIME_KEY,
  PI_LIVE_KEY,
  CHAT_TURN_HEARTBEAT_MS,
  OWNER_PURGE_STALE_LEASE_GRACE_MS,
  LOCAL_TURN_CANCEL_GRACE_MS,
  LOCAL_TURN_LEASE_KEY,
  localTurnReceiptKey,
  ownerPurgeImportedLeaseKey,
  orchestratorFenceLeaseReceiptKey,
  TERMINAL_NOTICE,
} from "./orchestrator/constants.js";
import {
  OwnerPurgeFenceError,
  json,
  errorMessage,
  log,
} from "./orchestrator/support.js";
import { OrchestratorTurnStart } from "./orchestrator/turn-start.js";

/**
 * The cloud orchestrator: Stella's delegation-only agent loop running inside
 * a Durable Object — one DO per conversation, one turn at a time, ~token
 * cost only. No sandbox is ever created here; escalation is the spawn tool,
 * which dispatches a general agent into a BuildSession sandbox and returns
 * immediately.
 *
 * This object OWNS its conversation. The transcript lives in its SQLite (see
 * `journal.ts`) and is the single source of truth for message content; the owner
 * keeps only the derived conversation-list projection it alone can serve.
 * There is no per-turn transcript round trip left:
 * the loop reads its context from local storage and writes produced messages
 * back incrementally as they are produced, so an eviction at minute four of a
 * five-minute turn no longer discards everything the turn did.
 *
 * This object is also the turn gateway's admission authority. A turn start
 * arrives from the Worker with a verified caller on trusted headers; the DO
 * decides idempotency (by `clientMsgId`), ownership (a fresh conversation
 * adopts its first verified caller — conversation ids are client-minted
 * UUIDs), owner policy (through the owner gate), the execution, and mints the turn's
 * model capability itself. The owner's object learns what it indexes through
 * owner events: `conversation.created`, `turn.started`, the `turn.event`s it
 * reads (with a DO-assigned `eventSeq`), `conversation.index`,
 * `thread.spawned`, `conversation.deleted`. Everything else a turn touches
 * (web search, schedules, drive attachments, integrations, the agent home) is
 * an owner-object call. The model queries the local journal through
 * `history.sql` in code.
 *
 * What did NOT change, deliberately: the turn lifecycle. Accepted turns are
 * still durable under `queued:*` before the 202, the alarm still retries
 * terminal delivery (now "retry the owner delivery"), and `terminal` /
 * `terminalDelivered` still guarantee exactly one terminal state. The
 * journal's `turns` table is a projection of that machinery and is never
 * consulted to decide whether a terminal event is owed.
 *
 * The loop itself is `packages/runtime`'s agent-core Agent — the same code
 * the desktop ships — with the tool set pinned in `orchestrator/tools.ts`.
 * Frontmatter allowlists are agent-writable home data on desktop; in the
 * cloud the execution surface is never data-driven.
 */

export type { ChatTurnRequest } from "./orchestrator/types.js";

export class OrchestratorSessionObject extends OrchestratorTurnStart {
  async ready(): Promise<void> {
    await this.readerReady;
  }

  /**
   * Advisory cold-start hint for the owner gate. The nonce has no authority:
   * the gate still validates the exact lease and policy before it can issue a
   * grant bound to this reader. The shell awaits `ready()` before any call.
   */
  async prepareCloudChatReader(): Promise<string> {
    return this.isolateId;
  }

  async alarm(): Promise<void> {
    try {
      await this.conversationAlarm();
    } finally {
      await this.piHeartbeat().catch((error: unknown) => {
        log("error", "pi_heartbeat_failed", { message: errorMessage(error) });
      });
    }
  }

  private async conversationAlarm(): Promise<void> {
    // A turn can finish after its remote lease was removed but before the
    // unregister response arrived. Reconcile that durable debt before using
    // this wake-up for the conversation lifecycle. Same for projections the
    // queue refused at admission time.
    await this.retryOwnerFenceLeaseRetirements();
    await this.retryOwnerEventDebt();
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease) {
      if (localLease.cancelRequested) {
        const deadline = localLease.cancelDeadlineAt;
        if (!Number.isFinite(deadline) || deadline! <= 0) {
          // Migration/failure-safe path for a cancellation written before the
          // deadline field existed: grant a full fresh grace, never release now.
          localLease.cancelDeadlineAt = Date.now() + LOCAL_TURN_CANCEL_GRACE_MS;
          await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, localLease);
          await this.ctx.storage.setAlarm(localLease.cancelDeadlineAt);
          return;
        }
        if (Date.now() < deadline!) {
          await this.ctx.storage.setAlarm(deadline!);
          return;
        }
        await this.cancelLocalTurn(localLease, true);
      } else if (localLease.expiresAt <= Date.now()) {
        await this.expireLocalLease(localLease, true);
      } else {
        await this.armLocalLeaseAlarm(localLease.expiresAt);
      }
      return;
    }
    const turn = await this.ctx.storage.get<ChatTurnRequest>("turn");
    if (!turn || (await this.ctx.storage.get<boolean>("terminalDelivered"))) {
      // Nothing owed for the turn under `turn` — but this firing still spent
      // the alarm, and the queue may not be empty. Both of these are reachable
      // with work outstanding: `!turn` is a first-ever dispatch whose watchdog
      // beat `runTurn` to the claim, and `terminalDelivered` is the ordinary
      // watchdog of a turn that finished while a later one was queued behind
      // it.
      await this.ensureQueueAlarm();
      return;
    }
    // The heartbeat of a turn running in this isolate: nothing is owed and
    // nothing is lost, so re-arm without the owner-lease round trips the
    // watchdog path below needs for its writes.
    if (this.turnExecutions.has(turn.turnId)) {
      const [owed, watchdogAt] = await Promise.all([
        this.owedTerminal(turn),
        this.getTurnState<number>("turnWatchdogAt"),
      ]);
      const now = Date.now();
      if (!owed && watchdogAt !== undefined && now < watchdogAt) {
        await this.armAlarmNoLaterThan(
          Math.min(watchdogAt, now + CHAT_TURN_HEARTBEAT_MS),
        );
        return;
      }
    }
    const alarmTurn = { ...turn };
    try {
      alarmTurn.ownerPurgeGeneration = await this.registerOwnerTurn(
        alarmTurn,
        true,
      );
      await this.assertOwnerTurn(alarmTurn);
      await this.runAlarm(alarmTurn);
    } catch (error) {
      if (error instanceof OwnerPurgeFenceError) {
        this.currentTurnCancellation?.abort();
        this.currentPiRun?.abort();
        return;
      }
      throw error;
    } finally {
      await this.unregisterOwnerTurn(alarmTurn);
    }
  }

  private async runAlarm(turn: ChatTurnRequest): Promise<void> {
    // The alarm is two jobs sharing one wake-up: the watchdog, and the retry
    // ladder every other terminal path re-arms when its owner delivery fails.
    // Only the first job may terminate a turn. Running the timeout path over a
    // turn that is already canceled or failed writes a SECOND terminal row —
    // `recordTerminal` keys on the phase, so it is a distinct row, not a
    // replay — and the clients group on the last row per turn, so the user who
    // pressed Stop is told the turn timed out instead.
    let owed = await this.owedTerminal(turn);
    if (!owed) {
      const watchdogAt = await this.ctx.storage.get<number>("turnWatchdogAt");
      if (watchdogAt !== undefined && Date.now() < watchdogAt) {
        // Projection retries and lease reconciliation share this alarm. An
        // earlier maintenance wake must not time out a healthy active turn.
        // A turn running here keeps its heartbeat; one this isolate never
        // resumed (its resume budget is spent) waits for the watchdog, as
        // every lost turn did before resume existed.
        await this.armAlarmNoLaterThan(
          this.turnExecutions.has(turn.turnId)
            ? Math.min(watchdogAt, Date.now() + CHAT_TURN_HEARTBEAT_MS)
            : watchdogAt,
        );
        return;
      }
      await this.ctx.storage.put("terminal", true);
      // Marking the turn terminal is not enough — the loop would keep burning
      // metered relay calls for output runTurn will discard.
      this.currentTurnCancellation?.abort();
      this.currentPiRun?.abort();
      if (!this.currentPiRun) {
        await this.abortPiConversation().catch((error: unknown) => {
          log("error", "pi_conversation_abort_failed", {
            turnId: turn.turnId,
            message: errorMessage(error),
          });
        });
      }
      log("error", "chat_turn_timed_out", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
      });
      // Additive: the journal row a socket client needs to stop showing a
      // spinner. It is written whether or not the owner event below lands —
      // the two deliveries are independent, and this one has no retry ladder
      // because it cannot fail transiently.
      this.recordTerminal(turn, "timeout", TERMINAL_NOTICE.timeout);
      owed = { kind: "timeout", message: TERMINAL_NOTICE.timeout };
      await this.ctx.storage.put("terminalOwed", owed);
    }
    try {
      await this.emitTurnEvent(
        turn,
        owed.kind,
        owed.payload ?? { message: owed.message },
        {
          terminal: true,
          eventSeq: await this.terminalEventSeq(turn, owed),
          ...(owed.kind !== "completed" ? { errorMessage: owed.message } : {}),
        },
      );
      await this.ctx.storage.put("terminalDelivered", true);
    } catch (error) {
      // A single enqueue attempt would strand the turn "running" on one
      // transient queue failure; retry via a re-armed alarm.
      const attempts =
        ((await this.ctx.storage.get<number>("alarmAttempts")) ?? 0) + 1;
      if (attempts <= 5) {
        await this.ctx.storage.put("alarmAttempts", attempts);
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      } else {
        await this.ctx.storage.put("terminalDelivered", true);
        log("error", "terminal_delivery_abandoned", {
          turnId: turn.turnId,
          message: errorMessage(error),
        });
      }
    }
    // The loop that would have released the gate is gone with the isolate
    // that ran it; the alarm is the last party that knows this turn ended.
    await this.releaseOwnerGate(turn);
    // Before the projection work, not after it. Every exit above has now
    // either re-armed the alarm for its own retry or consumed it for good, so
    // this is the first moment the queue can be honestly re-fenced — and
    // `finalizeTerminalTurn` below is the window the finding turns on: an
    // index flush (an owner round trip with a 30 s timeout) and a possible R2
    // segment cut, during which the isolate can be evicted or redeployed. Arm
    // first and that eviction costs a wake-up; arm after and it costs the
    // queued turn.
    await this.ensureQueueAlarm();
    // Last, so the terminal event is never held up by projection work — but
    // unconditionally, on the delivered and the re-armed path alike. A
    // timed-out turn owes the same post-terminal work as a completed one:
    // without it the whole turn, including everything the model produced
    // before the watchdog fired, is absent from the search index forever, and any card
    // staged while it ran sits in the inbox until the user happens to send
    // another message in that conversation.
    await this.finalizeTerminalTurn(turn);
  }

  /**
   * Slack's events route binds this conversation to the thread its replies
   * go to, before each Slack turn. Internal: only the Worker reaches it. A
   * conversation already owned by someone else refuses.
   */
  private async handleSlackBind(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const text = (value: unknown, max = 128): string | null =>
      typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
    const teamId = text(body?.teamId);
    const channelId = text(body?.channelId);
    const ownerId = text(body?.ownerId, 512);
    const requesterUserId = text(body?.requesterUserId);
    const clientMsgId = text(body?.clientMsgId);
    const triggerTs = text(body?.triggerTs);
    const threadTs = body?.threadTs === null ? null : text(body?.threadTs);
    if (!teamId || !channelId || !ownerId || !requesterUserId || !clientMsgId || !triggerTs || threadTs === undefined) {
      return json({ error: "Malformed Slack binding." }, 400);
    }
    if (this.purged()) return json({ error: "Conversation deleted." }, 410);
    const owner = this.journal.meta().owner_id;
    if (owner && owner !== ownerId) return json({ error: "owner_mismatch" }, 403);
    await this.slack().bind({
      teamId,
      channelId,
      threadTs,
      ownerId,
      requesterUserId,
      shared: body?.shared === true,
      clientMsgId,
      triggerTs,
    });
    return json({ bound: true });
  }

  /**
   * Stop from Slack: the running and queued turns are canceled, and every
   * background agent a Slack request started here is paused, so nothing
   * reports back afterwards. Internal; the Worker has checked that the person
   * pressing Stop owns the conversation.
   */
  private async handleSlackStop(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const ownerId = typeof body?.ownerId === "string" ? body.ownerId : "";
    const hostTurnId = typeof body?.hostTurnId === "string" ? body.hostTurnId : "";
    const slackUserId = typeof body?.slackUserId === "string" ? body.slackUserId : "";
    if (!ownerId || !hostTurnId || !slackUserId) return json({ error: "Malformed stop." }, 400);
    if (this.journal.meta().owner_id !== ownerId) return json({ error: "owner_mismatch" }, 403);
    const relay = this.slack();
    const tracked = await relay.runningAgentIds();
    relay.stopped(hostTurnId, slackUserId);
    const turnIds = new Set<string>();
    const current = await this.ctx.storage.get<{ turnId: string; ownerId: string }>("turn");
    if (current?.ownerId === ownerId) turnIds.add(current.turnId);
    for (const queued of await this.queuedTurns()) {
      if (queued.ownerId === ownerId) turnIds.add(queued.turnId);
    }
    const canceled: string[] = [];
    for (const turnId of turnIds) {
      try {
        await this.cancelTurn(turnId);
        canceled.push(turnId);
      } catch (error) {
        log("error", "slack_stop_turn_failed", { turnId, message: errorMessage(error) });
      }
    }
    // Every agent running here, the request's own and any it started in
    // turn, then once more for one that was starting while the first pass ran.
    const paused = new Set<string>();
    const runtime = await this.openPiRuntime(this.piGatewayOrigin());
    const { contextFor } = await import("./pi-runtime.js");
    const pauseRunning = async (extra: string[]): Promise<void> => {
      const running = await runtime.runningAgents(contextFor()).catch(() => []);
      for (const threadId of new Set([...extra, ...running.map((agent) => agent.agentId)])) {
        if (paused.has(threadId)) continue;
        try {
          await runtime.pauseThreadAgent(threadId, contextFor());
          paused.add(threadId);
        } catch (error) {
          log("error", "slack_stop_agent_failed", { threadId, message: errorMessage(error) });
        }
      }
    };
    await pauseRunning(tracked);
    await scheduler.wait(2_000);
    await pauseRunning([]);
    log("info", "slack_stop", { conversationId: this.conversationId(), canceled, paused: [...paused] });
    return json({ stopped: true, canceled, paused: [...paused] });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/socket") return this.handleSocket(request);
    if (request.method === "GET") {
      if (url.pathname === "/history") {
        return this.handleCanonicalHistory(request);
      }
      if (url.pathname === "/journal") return this.handleJournalProbe(url);
      if (url.pathname === "/pi-brain") return this.handlePiBrain(request);
      return json({ error: "Not found." }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }
    if (url.pathname === "/history/query") {
      return this.handleHistoryQuery(request);
    }
    if (url.pathname === JOURNAL_CHECKPOINT_PATH) {
      return this.handleJournalCheckpoint(request);
    }
    if (url.pathname === "/pi-workspace") {
      return this.handlePiWorkspace(request);
    }
    if (url.pathname === "/pi-brain") {
      return this.handlePiBrain(request);
    }
    // A pi agent's container daemon (its drive and its delivered files),
    // under its lease's own credential.
    if (url.pathname === "/pi-turn-broker") {
      // Only where pi runs agents: a pi conversation, or one hosting a computer's cloud agent.
      if (
        !this.piRuntime &&
        (await this.ctx.storage.get<string>(AGENT_RUNTIME_KEY)) !== "pi" &&
        !(await this.ctx.storage.get<boolean>(PI_LIVE_KEY))
      ) {
        return json({ error: "Turn broker request failed." }, 401);
      }
      const runtime = await this.openPiRuntime(this.piGatewayOrigin());
      return await runtime.handleBroker(request);
    }
    // Frames of the running Claude Code turn, from its BuildSession. These
    // only ever touch the exact active turn.
    if (url.pathname === CLOUD_CLI_TURN_DO_PATHS.tool) {
      return this.handleCliTurnTool(request);
    }
    if (url.pathname === CLOUD_CLI_TURN_DO_PATHS.events) {
      return this.handleCliTurnEvents(request);
    }
    if (url.pathname === CLOUD_CLI_TURN_DO_PATHS.terminal) {
      return this.handleCliTurnTerminal(request);
    }
    if (url.pathname === "/internal/dev-acceptance/probe") {
      return this.handleDevAcceptanceProbe(request);
    }
    if (url.pathname === "/local-turns/begin") {
      return this.handleLocalTurnBegin(request);
    }
    if (url.pathname === "/local-turns/finish") {
      return this.handleLocalTurnFinish(request);
    }
    if (url.pathname === "/journal") return this.handleJournalAppend(request);
    if (url.pathname === "/slack/bind") return this.handleSlackBind(request);
    if (url.pathname === "/slack/stop") return this.handleSlackStop(request);
    if (url.pathname === "/cards") return this.handleCard(request);
    if (url.pathname === "/purge") return this.handlePurge();
    if (url.pathname === "/owner-purge-cancel") {
      const body = (await request.json().catch(() => ({}))) as {
        ownerId?: string;
        ownerGeneration?: string;
        turnId?: string;
        generation?: string;
        leaseId?: string;
      };
      const turnId = body.turnId?.trim() ?? "";
      const ownerId = body.ownerId?.trim() ?? "";
      const ownerGeneration = body.ownerGeneration?.trim() ?? "";
      const generation = body.generation?.trim() ?? "";
      const leaseId = body.leaseId?.trim() ?? "";
      if (!turnId || !ownerId || !ownerGeneration || !generation || !leaseId) {
        return json({ error: "Owner purge lease identity required." }, 400);
      }
      // A placed turn can still be in transit from OwnerGate. Retain this
      // rejection after the exact lease receipt is retired.
      await this.ctx.storage.put(ownerPurgeImportedLeaseKey(leaseId), {
        ownerId,
        ownerGeneration,
        turnId,
      });
      const leaseReceipt = await this.ctx.storage.get<OwnerFenceLeaseReceipt>(
        orchestratorFenceLeaseReceiptKey(leaseId),
      );
      const callbackIdentity = { ownerId, ownerGeneration, turnId };
      const receiptMatches = Boolean(
        leaseReceipt &&
          this.ownerFenceReceiptMatches(
            leaseReceipt,
            callbackIdentity,
            leaseId,
          ),
      );
      if (leaseReceipt && !receiptMatches) {
        return json({ error: "Owner purge lease identity is stale." }, 409);
      }
      const matchesExactLease = (candidate: OwnerFencedTurn): boolean =>
        candidate.turnId === turnId &&
        candidate.ownerId === ownerId &&
        candidate.ownerGeneration === ownerGeneration &&
        candidate.ownerPurgeLeaseId === leaseId;
      const [current, localLease, queuedTurn] = await Promise.all([
        this.ctx.storage.get<ChatTurnRequest>("turn"),
        this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY),
        this.ctx.storage.get<ChatTurnRequest>(`queued:${turnId}`),
      ]);
      const ownerFencedAppend = this.ownerFencedAppends.get(leaseId);
      // A durable old receipt authorizes retiring only that exact old lease;
      // it never authorizes touching an ABA successor that reused the turn id.
      const hasAbaSuccessor = [
        current,
        localLease,
        queuedTurn,
        ownerFencedAppend?.lease,
      ].some(
        (candidate) =>
          candidate?.turnId === turnId && !matchesExactLease(candidate),
      );
      if (hasAbaSuccessor && receiptMatches && leaseReceipt) {
        if (
          !(await this.retireOwnerFenceLeaseReceipt(leaseReceipt, generation))
        ) {
          return json(
            { error: "Owner purge lease retirement is pending." },
            409,
          );
        }
        return json({
          canceled: false,
          reason: "stale_owner_purge_identity",
          turnId,
          unregistered: true,
        });
      }
      if (hasAbaSuccessor) {
        return json({ error: "Owner purge lease identity is stale." }, 409);
      }
      const currentMatches = Boolean(current && matchesExactLease(current));
      const localMatches = Boolean(localLease && matchesExactLease(localLease));
      const queuedMatches = Boolean(
        queuedTurn && matchesExactLease(queuedTurn),
      );
      const appendMatches = Boolean(
        ownerFencedAppend && matchesExactLease(ownerFencedAppend.lease),
      );

      if (
        receiptMatches &&
        leaseReceipt &&
        !currentMatches &&
        !localMatches &&
        !queuedMatches &&
        !appendMatches
      ) {
        // register may commit remotely before the caller persists its domain
        // row. The receipt is the exact local recovery identity for that gap.
        if (
          !(await this.retireOwnerFenceLeaseReceipt(leaseReceipt, generation))
        ) {
          return json(
            { error: "Owner purge lease retirement is pending." },
            409,
          );
        }
        return json({
          canceled: true,
          turnId,
          unregistered: true,
          orphan: true,
        });
      }

      if (localMatches && localLease) {
        try {
          await this.cancelLocalTurn(localLease, false);
        } catch {
          return json({ error: "Owner local turn is still unwinding." }, 409);
        }
        const retained =
          await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
        if (
          retained?.turnId === turnId &&
          retained.leaseToken === localLease.leaseToken
        ) {
          return json(
            {
              error:
                "Waiting for the desktop provider to acknowledge cancellation.",
              retryAfterMs: 1_000,
            },
            409,
          );
        }
      }
      const completedLocal = await this.ctx.storage.get<LocalTurnFinishReceipt>(
        localTurnReceiptKey(turnId),
      );
      if (
        completedLocal?.turnId === turnId &&
        completedLocal.ownerGeneration === ownerGeneration &&
        completedLocal.externallyCanceled
      ) {
        if (
          !(await this.retireOwnerFenceLeaseByIdentity(
            callbackIdentity,
            leaseId,
            generation,
          ))
        ) {
          return json(
            { error: "Owner purge lease retirement is pending." },
            409,
          );
        }
        return json({
          canceled: true,
          turnId,
          unregistered: true,
          local: true,
        });
      }
      if (appendMatches && ownerFencedAppend) {
        // Voice writes have no provider to abort, but their generation-fenced
        // R2/SQLite work must finish and drop its owner lease before purge can
        // report quiescence.
        await ownerFencedAppend.settled;
        if (
          !(await this.retireOwnerFenceLeaseByIdentity(
            callbackIdentity,
            leaseId,
            generation,
          ))
        ) {
          return json(
            { error: "Owner purge lease retirement is pending." },
            409,
          );
        }
        return json({
          canceled: true,
          turnId,
          unregistered: true,
          voice: true,
        });
      }
      if (queuedMatches && queuedTurn) {
        if (!(await this.unregisterOwnerTurn(queuedTurn))) {
          return json(
            { error: "Owner purge lease retirement is pending." },
            409,
          );
        }
        await this.ctx.storage.delete(`queued:${turnId}`);
        // A queued turn owns no provider or callback yet; deleting its exact
        // durable key and lease is already quiescent.
        if (!currentMatches) {
          return json({ canceled: true, turnId, unregistered: true });
        }
      }

      if (currentMatches) {
        await this.ctx.storage.put("terminal", true);
        this.currentTurnCancellation?.abort();
        this.currentPiRun?.abort();
      }
      const execution = currentMatches
        ? this.turnExecutions.get(turnId)
        : undefined;
      if (execution) {
        try {
          // The durable terminal bit fences callbacks; interrupting the Effect
          // supervisor also closes the local admission latch and boundedly
          // joins any promise-native setup/provider/tool work. Without this,
          // an owner purge during pre-Agent setup could return 409 after merely
          // calling abort() on no Agent at all, then let setup keep mutating the
          // conversation until a later assertion happened to notice.
          await execution.interrupt(
            new Error("Owner cloud activity is being purged."),
          );
        } catch {
          return json({ error: "Owner turn is still unwinding." }, 409);
        }
      }
      if (this.activeTurnId === turnId) {
        return json({ error: "Owner turn is still unwinding." }, 409);
      }
      if (!execution) {
        const key = `ownerPurgeCancelAt:${leaseId}`;
        const startedAt =
          (await this.ctx.storage.get<number>(key)) ?? Date.now();
        await this.ctx.storage.put(key, startedAt);
        if (Date.now() - startedAt < OWNER_PURGE_STALE_LEASE_GRACE_MS) {
          return json({ error: "Reconciling stale owner turn lease." }, 409);
        }
        await this.ctx.storage.delete(key);
      }
      if (
        !(await this.retireOwnerFenceLeaseByIdentity(
          callbackIdentity,
          leaseId,
          generation,
        ))
      ) {
        return json({ error: "Owner purge lease retirement is pending." }, 409);
      }
      return json({ canceled: true, turnId, unregistered: true });
    }
    if (url.pathname === "/cancel") {
      const cancellation = parseExactTurnCancellationRequest(
        await request.json().catch(() => null),
      );
      if (!cancellation) {
        // Legacy conversation-wide cancellation is intentionally retired. It
        // cannot prove which turn it owns and must never stop a newer one.
        return json(
          { canceled: false, reason: "exact_turn_identity_required" },
          400,
        );
      }
      return await this.cancelExactChatTurn(cancellation);
    }
    if (url.pathname !== "/turn") return json({ error: "Not found." }, 404);
    return await this.handleTurnStart(request);
  }

  /**
   * Turn admission. The Worker has verified the caller and stamped the
   * trusted identity headers; everything else is decided here, in this
   * order: request shape, service-only fields, ownership (adopting a fresh
   * conversation), idempotency on `clientMsgId`, the owner gate, the
   * execution, then the durable admission intent, the owner fence, and the
   * queued turn — with the projections the owner needs going out last.
   */
  async startAdmittedChat(
    start: CloudTurnStartRequest,
    authority: AdmittedCloudChat,
    preparation: CloudChatPreparation,
  ): Promise<Response> {
    const preparedGrant = authority.ownerModelGrant;
    if (preparedGrant !== undefined)
      this.admittedOwnerModelGrants.set(authority.turnId, preparedGrant);
    const response = await this.handleTurnStart(
      new Request("https://orchestrator-session/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HEADER_OWNER]: authority.ownerId,
          [HEADER_TURN_AUTH_KIND]: "service",
          [TURN_OWNER_GENERATION_HEADER]: authority.ownerGeneration,
        },
        body: JSON.stringify(start),
      }),
      { authority, preparation },
    );
    if (response.status !== 202)
      this.admittedOwnerModelGrants.delete(authority.turnId);
    return response;
  }

  async freezeOwnerModelGrants(
    args: OwnerModelGrantFreezeRequest,
  ): Promise<{ frozen: true }> {
    // This is deliberately synchronous before the ACK. It never waits for a
    // turn, provider, or OwnerGate, so a privacy change cannot deadlock on the
    // request it is revoking.
    this.localOwnerModelGrants.freeze(args);
    return { frozen: true };
  }

  private async handleSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected a WebSocket upgrade." }, 426);
    }
    // These headers are trustable because a Durable Object namespace is not
    // publicly addressable: only the worker can produce this request, and it
    // strips any client-supplied x-stella-* before forwarding. Their absence
    // means the request did not come through that path.
    const identity = parseSocketIdentity(request);
    if (!identity) return json({ error: "Unauthorized." }, 401);
    // No tombstone pre-check here. A plain 4xx before the 101 reaches a browser
    // as close code 1006 with no detail, so "deleted" would be indistinguishable
    // from a network fault. The hub completes the handshake and closes 4410 with
    // a readable `error` frame first.
    return this.hub.upgrade(request, identity);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.hub.onMessage(ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    await this.hub.onClose(ws, code, reason, wasClean);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.hub.onError(ws, error);
  }

  /**
   * `history.*` for a cloud agent spawned from this conversation. The
   * BuildSession names the owner its turn was admitted under; a conversation
   * bound to anyone else, or deleted, answers nothing.
   */
  async queryHistory(ownerId: string, request: unknown): Promise<unknown> {
    if (this.purged() || !ownerId || this.journal.ownerId() !== ownerId) {
      throw new Error("history is unavailable in this session.");
    }
    return await this.runHistoryOp(request);
  }
}
