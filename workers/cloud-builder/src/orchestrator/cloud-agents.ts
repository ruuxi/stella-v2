import {
  cloudAgentActivationCard,
  cloudAgentTerminalCard,
} from "../cloud-agent-lifecycle.js";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import { readAgentDirectory } from "../agent-messaging.js";
import type { CloudTurnStartRequest } from "@stella/contracts/turn-plane/turn-start";
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
import type { WakeReport, ChatTurnRequest } from "./types.js";
import { WAKE_REPORT_INLINE_MAX_BYTES } from "./constants.js";
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

  protected async wakeCanceled(wake: ChatTurnRequest): Promise<boolean> {
    return (
      (await this.exactTurnCancellations.matching({
        turnId: wake.turnId,
        ownerId: wake.ownerId,
        ownerGeneration: wake.ownerGeneration,
      })) !== null
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
