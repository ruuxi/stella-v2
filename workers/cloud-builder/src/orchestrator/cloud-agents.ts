import {
  cloudAgentActivationCard,
  cloudAgentTerminalCard,
} from "../cloud-agent-lifecycle.js";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import type { CloudTurnStartRequest } from "@stella/contracts/turn-plane/turn-start";
import { readAgentDirectory } from "../agent-messaging.js";
import { renderAgentRoster } from "@stella/contracts/agent-directory";
import {
  type CloudAgentControlReceipt,
  type CloudAgentToolKind,
  type CloudAgentToolOutcome,
  commitCloudAgentToolOutcome as commitSharedCloudAgentToolOutcome,
  isCloudAgentControlActive,
  readCloudAgentToolOutcome as readSharedCloudAgentToolOutcome,
  rememberCloudAgentControlReceipt as rememberSharedCloudAgentControlReceipt,
  requireCloudAgentControlReceipt as requireSharedCloudAgentControlReceipt,
} from "../cloud-agent-dispatch.js";
import { unwrapRpc } from "../owner-store/errors.js";
import { MAX_ROW_BYTES, utf8Length } from "../conversation-types.js";
import type {
  WakeReport,
  SteeredWake,
  SteerableTurn,
  ChatTurnRequest,
  OwnerFenceLeaseReceipt,
} from "./types.js";
import {
  WAKE_REPORT_INLINE_MAX_BYTES,
  WAKE_STEER_DEADLINE_MARGIN_MS,
  turnEventSeqKey,
  OWNER_EVENT_BATCH_PREFIX,
  orchestratorFenceLeaseReceiptKey,
} from "./constants.js";
import { errorMessage, log } from "./support.js";
import { OrchestratorDevAcceptance } from "./dev-acceptance.js";

/**
 * Cloud agents: control receipts, wake reports, steering wakes into a running
 * turn, and agent cards.
 */
export abstract class OrchestratorCloudAgents extends OrchestratorDevAcceptance {
  /**
   * Advances the durable control receipt for one reusable cloud-agent thread.
   * Attempt generation is the primary ABA fence; updatedAt orders state within
   * an attempt. Older server responses are harmless, while two different
   * states claiming the same exact revision fail closed as protocol damage.
   */
  protected async rememberCloudAgentControlReceipt(
    value: unknown,
  ): Promise<CloudAgentControlReceipt> {
    return await rememberSharedCloudAgentControlReceipt(
      this.ctx.storage,
      value,
    );
  }

  protected async readCloudAgentToolOutcome(
    turn: ChatTurnRequest,
    toolCallId: string,
    kind: CloudAgentToolKind,
    fingerprint: string,
  ): Promise<CloudAgentToolOutcome | null> {
    const outcome = await readSharedCloudAgentToolOutcome({
      storage: this.ctx.storage,
      parentTurnId: turn.turnId,
      toolCallId,
      kind,
      fingerprint,
    });
    if (outcome) this.publishAgentActivation(turn, toolCallId, outcome);
    return outcome;
  }

  protected async commitCloudAgentToolOutcome(
    turn: ChatTurnRequest,
    toolCallId: string,
    kind: CloudAgentToolKind,
    fingerprint: string,
    value: unknown,
    disposition?: CloudAgentToolOutcome["disposition"],
  ): Promise<CloudAgentToolOutcome> {
    const outcome = await commitSharedCloudAgentToolOutcome({
      storage: this.ctx.storage,
      parentTurnId: turn.turnId,
      toolCallId,
      kind,
      fingerprint,
      value,
      ...(disposition ? { disposition } : {}),
    });
    this.publishAgentActivation(turn, toolCallId, outcome);
    return outcome;
  }

  protected async spillLargeWakeReport(
    start: CloudTurnStartRequest,
  ): Promise<string | undefined | null> {
    const control = start.agentThreadControl;
    if (!control) return undefined;
    const bytes =
      utf8Length(start.prompt) + utf8Length(control.lifecycleReport ?? "");
    if (bytes <= WAKE_REPORT_INLINE_MAX_BYTES) return undefined;
    const report: WakeReport = {
      prompt: start.prompt,
      ...(control.lifecycleReport !== undefined
        ? { lifecycleReport: control.lifecycleReport }
        : {}),
    };
    const key = await this.archive
      .writeSpill(`wake:${start.clientMsgId}`, JSON.stringify(report))
      .catch((error: unknown) => {
        log("error", "wake_report_spill_failed", {
          clientMsgId: start.clientMsgId,
          message: errorMessage(error),
        });
        return null;
      });
    return key ?? null;
  }

  protected async wakeReport(turn: ChatTurnRequest): Promise<WakeReport> {
    const inline: WakeReport = {
      prompt: turn.prompt,
      ...(turn.agentThreadControl?.lifecycleReport !== undefined
        ? { lifecycleReport: turn.agentThreadControl.lifecycleReport }
        : {}),
    };
    if (!turn.wakeReportSpillKey) return inline;
    const stored = (await this.archive.readSpill(turn.wakeReportSpillKey)) as {
      prompt?: unknown;
      lifecycleReport?: unknown;
    } | null;
    if (!stored || typeof stored.prompt !== "string") {
      throw new Error("The stored agent report could not be read.");
    }
    return {
      prompt: stored.prompt,
      ...(typeof stored.lifecycleReport === "string"
        ? { lifecycleReport: stored.lifecycleReport }
        : {}),
    };
  }

  protected async spillOversizePrompt(
    turnId: string,
    message: AgentMessage,
  ): Promise<{ payloadJson: string; spillKey?: string }> {
    const payloadJson = JSON.stringify(message);
    if (utf8Length(payloadJson) <= MAX_ROW_BYTES) return { payloadJson };
    const spillKey = await this.archive.writeSpill(
      `turn:${turnId}:prompt`,
      payloadJson,
    );
    if (!spillKey) throw new Error("The oversize prompt could not be stored.");
    return { payloadJson, spillKey };
  }

  protected publishAgentTerminal(
    turn: ChatTurnRequest,
    report?: WakeReport,
  ): void {
    const card = this.agentTerminalCard(turn, report);
    if (card) {
      this.publishAgentLifecycleCard(
        turn.turnId,
        turn.agentThreadControl!.threadUpdatedAt,
        card,
      );
    }
  }

  protected agentTerminalCard(turn: ChatTurnRequest, report?: WakeReport) {
    if (!turn.agentThreadControl) return null;
    const full =
      report?.lifecycleReport !== undefined
        ? cloudAgentTerminalCard({
            ...turn.agentThreadControl,
            lifecycleReport: report.lifecycleReport,
          })
        : null;
    return full && utf8Length(JSON.stringify(full)) <= MAX_ROW_BYTES
      ? full
      : cloudAgentTerminalCard(turn.agentThreadControl);
  }

  /**
   * This conversation's agents as the resident roster, for a context that
   * starts here. A failed read renders the context without it.
   */
  protected async agentRoster(
    turn: ChatTurnRequest,
  ): Promise<string | undefined> {
    try {
      const { agents } = await readAgentDirectory(
        {
          ownerGeneration: turn.ownerGeneration,
          ownerInternal: async (name, args) =>
            unwrapRpc(
              await this.ownerGate(turn.ownerId).ownerInternal({
                name,
                args,
                ownerGeneration: turn.ownerGeneration,
              }),
            ),
        },
        turn.conversationId,
      );
      return renderAgentRoster(agents);
    } catch (error) {
      log("error", "chat_agent_roster_failed", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        message: errorMessage(error),
      });
      return undefined;
    }
  }

  /**
   * Let a hidden agent wake (an agent's message or its completion report)
   * join the resident loop running here instead of waiting behind it. The
   * wake is already durable under `queued:`; this only offers it to the loop,
   * which takes it at its next steering poll (`takeSteeredWakes`). Anything
   * the loop does not take stays queued and runs as its own turn.
   */
  protected async steerWakeIntoRunningTurn(
    wake: ChatTurnRequest,
  ): Promise<void> {
    if (wake.lane !== "wake" || wake.source !== "agent-thread") return;
    const target = this.steerableTurn;
    if (
      !target ||
      !this.ctx.storage.kv ||
      target.turn.turnId === wake.turnId ||
      target.turn.ownerId !== wake.ownerId ||
      target.turn.ownerGeneration !== wake.ownerGeneration ||
      Date.now() >= target.watchdogAt - WAKE_STEER_DEADLINE_MARGIN_MS
    ) {
      return;
    }
    try {
      if (await this.wakeCanceled(wake)) return;
      const report = await this.wakeReport(wake);
      const message = {
        role: "user",
        content: [{ type: "text", text: report.prompt }],
        timestamp: Date.now(),
        source: wake.source,
      } as AgentMessage;
      // The loop's event sink is synchronous, so a row that would need the
      // R2 spill runs as its own turn.
      if (utf8Length(JSON.stringify(message)) > MAX_ROW_BYTES) return;
      if (this.steerableTurn !== target) return;
      target.waiting.push({ turn: wake, report, message });
    } catch (error) {
      log("error", "chat_wake_steer_skipped", {
        turnId: wake.turnId,
        intoTurnId: target.turn.turnId,
        message: errorMessage(error),
      });
    }
  }

  protected async wakeCanceled(wake: ChatTurnRequest): Promise<boolean> {
    return (
      (await this.exactTurnCancellations.matching({
        turnId: wake.turnId,
        ownerId: wake.ownerId,
        ownerGeneration: wake.ownerGeneration,
      })) !== null
    );
  }

  /** The loop's steering poll: the waiting wakes still queued and not stopped. */
  protected async takeSteeredWakes(
    target: SteerableTurn,
  ): Promise<AgentMessage[]> {
    if (this.steerableTurn !== target || target.waiting.length === 0) return [];
    if (Date.now() >= target.watchdogAt - WAKE_STEER_DEADLINE_MARGIN_MS) {
      return [];
    }
    const candidates = target.waiting.splice(0);
    const canceled = await Promise.all(
      candidates.map((wake) => this.wakeCanceled(wake.turn)),
    );
    const kv = this.ctx.storage.kv;
    const taken = candidates.filter(
      (wake, index) =>
        !canceled[index] && kv.get(`queued:${wake.turn.turnId}`) !== undefined,
    );
    for (const wake of taken) target.injected.set(wake.message, wake);
    if (taken.length > 0) {
      log("info", "chat_wake_steered", {
        turnId: target.turn.turnId,
        wakeTurnIds: taken.map((wake) => wake.turn.turnId),
      });
    }
    return taken.map((wake) => wake.message);
  }

  /**
   * A steered wake the running loop just read. Synchronous, from the loop's
   * event sink: the wake's prompt row (hidden, keyed to the wake so a replay
   * is a no-op) and its lifecycle card land in the running turn, and the
   * wake turn itself ends — dequeued, terminal in the journal so its own
   * queued run is skipped, its owner terminal owed and its lease retirement
   * recorded — in the same transaction.
   */
  protected absorbSteeredWake(
    running: ChatTurnRequest,
    steered: SteeredWake,
  ): void {
    const { turn: wake, report, message } = steered;
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    const card = this.agentTerminalCard(wake, report);
    const batchKey = `${OWNER_EVENT_BATCH_PREFIX}${crypto.randomUUID()}`;
    const written = this.ctx.storage.transactionSync(() => {
      const prompt = this.journal.appendMessage({
        turnId: running.turnId,
        writer: "orchestrator",
        writerKey: `turn:${wake.turnId}:prompt`,
        role: "user",
        hidden: true,
        createdAt: now,
        message,
      });
      this.journal.setTurnSpan(running.turnId, prompt.seq);
      const cardRow = card
        ? this.journal.appendCard({
            turnId: running.turnId,
            createdAt: wake.agentThreadControl!.threadUpdatedAt,
            card,
            writer: "orchestrator",
            writerKey: card.eventId,
          })
        : null;
      if (cardRow) this.journal.setTurnSpan(running.turnId, cardRow.seq);
      if (kv.get(`queued:${wake.turnId}`) === undefined) {
        return { prompt, cardRow, event: null };
      }
      this.journal.upsertTurn({
        turnId: wake.turnId,
        sessionId: wake.sessionId,
        ownerId: wake.ownerId,
        lane: wake.lane,
        source: wake.source,
        clientMsgId: wake.clientMsgId,
        state: "running",
        now,
      });
      const range = this.journal.turnContextRange(running.turnId);
      if (range) {
        this.journal.setTurnContext(wake.turnId, range.startSeq, range.endSeq);
      }
      this.journal.setTurnSpan(wake.turnId, prompt.seq);
      this.journal.setTurnTerminal(wake.turnId, "completed", now);
      kv.delete(`queued:${wake.turnId}`);
      const seqKey = turnEventSeqKey(wake.turnId);
      const eventSeq = (kv.get<number>(seqKey) ?? 0) + 1;
      kv.put(seqKey, eventSeq);
      const event = this.turnEvent(
        wake,
        "completed",
        { text: "", wallClockMs: 0, steeredInto: running.turnId },
        eventSeq,
        { terminal: true, resultJson: JSON.stringify({ finalText: "" }) },
      );
      kv.put(batchKey, [event]);
      const leaseId = wake.ownerPurgeLeaseId;
      const receiptKey = leaseId
        ? orchestratorFenceLeaseReceiptKey(leaseId)
        : undefined;
      const receipt = receiptKey
        ? kv.get<OwnerFenceLeaseReceipt>(receiptKey)
        : undefined;
      if (
        receiptKey &&
        receipt &&
        this.ownerFenceReceiptMatches(receipt, wake, leaseId!)
      ) {
        kv.put(receiptKey, {
          ...receipt,
          phase: "unregister_pending",
          updatedAt: now,
        } satisfies OwnerFenceLeaseReceipt);
      }
      return { prompt, cardRow, event };
    });
    if (written.prompt.inserted) this.publish(written.prompt.record);
    if (written.cardRow?.inserted) this.publish(written.cardRow.record);
    if (!written.event) return;
    const event = written.event;
    log("info", "chat_wake_absorbed", {
      turnId: wake.turnId,
      intoTurnId: running.turnId,
      promptSeq: written.prompt.seq,
    });
    this.ctx.waitUntil(
      (async () => {
        await this.deliverDeferredOwnerEvents(batchKey, [event]);
        await this.unregisterOwnerTurn(wake);
        await this.releaseOwnerGate(wake);
      })().catch((error: unknown) => {
        log("error", "chat_wake_absorb_release_failed", {
          turnId: wake.turnId,
          message: errorMessage(error),
        });
      }),
    );
  }

  protected publishAgentLifecycleCard(
    turnId: string,
    createdAt: number,
    card: import("@stella/contracts/cloud-agent-lifecycle").CloudAgentLifecycleCard,
  ): void {
    const appended = this.journal.appendCard({
      turnId,
      createdAt,
      card,
      writer: "orchestrator",
      writerKey: card.eventId,
    });
    this.journal.setTurnSpan(turnId, appended.seq);
    if (appended.inserted) this.publish(appended.record);
  }

  /**
   * A `files` card for drive files the orchestrator's own turn produced. The
   * owner only files cards for spawned threads (`applyThreadCompleted`),
   * so a direct tool such as `image_gen` publishes its own. Same card shape
   * the clients already render for thread output.
   */
  protected publishTurnFilesCard(
    turnId: string,
    writerKey: string,
    files: Array<{
      path: string;
      name: string;
      sizeBytes: number;
      contentType: string;
    }>,
  ): void {
    const appended = this.journal.appendCard({
      turnId,
      card: {
        type: "files",
        files: files.map((file) => ({ ...file, stored: true })),
      },
      writer: "orchestrator",
      writerKey,
    });
    this.journal.setTurnSpan(turnId, appended.seq);
    if (appended.inserted) this.publish(appended.record);
  }

  protected publishAgentActivation(
    turn: ChatTurnRequest,
    toolCallId: string,
    outcome: CloudAgentToolOutcome,
  ): void {
    const card = cloudAgentActivationCard({
      outcome,
      parentTurnId: turn.turnId,
      toolCallId,
    });
    if (card)
      this.publishAgentLifecycleCard(
        turn.turnId,
        outcome.control.threadUpdatedAt,
        card,
      );
  }

  protected async requireCloudAgentControlReceipt(
    threadIdValue: string,
    expected: "running" | "terminal" | "any",
  ): Promise<CloudAgentControlReceipt> {
    const receipt = await requireSharedCloudAgentControlReceipt({
      storage: this.ctx.storage,
      threadId: threadIdValue,
    });
    const statusMatches =
      expected === "any"
        ? true
        : expected === "running"
          ? isCloudAgentControlActive(receipt.status)
          : !isCloudAgentControlActive(receipt.status);
    if (!statusMatches) {
      throw new Error(
        expected === "running"
          ? `${receipt.threadId} is not currently running.`
          : `${receipt.threadId} is still working.`,
      );
    }
    return receipt;
  }
}
