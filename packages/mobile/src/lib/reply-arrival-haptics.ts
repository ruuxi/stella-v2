import type { ChatMessage } from "../types";
import {
  hasToolCalls,
  type JournalRecord,
} from "./cloud-conversation-protocol";
import type { ConversationState } from "./cloud-conversation-store";
import { cloudTurnActivity } from "./cloud-journal-projection";

/** Eligibility belongs to fresh sends on this surface, never restored history. */
export class ReplyArrivalHaptics {
  private pending = new Set<string>();

  arm(userMessageId: string): void {
    this.pending.add(userMessageId);
  }

  reset(): void {
    this.pending.clear();
  }

  observeConnection(
    snapshot: Pick<
      ConversationState,
      "status" | "epoch" | "records" | "headSeq"
    >,
  ): void {
    if (
      snapshot.status !== "live" ||
      snapshot.epoch === null ||
      (snapshot.records.at(-1)?.seq ?? -1) < snapshot.headSeq
    )
      this.reset();
  }

  take(
    messages: readonly ChatMessage[],
    records: readonly JournalRecord[],
  ): string[] {
    if (this.pending.size === 0) return [];
    const bySequence = new Map(records.map((record) => [record.seq, record]));
    const unsuccessful = new Set(
      records.flatMap((record) =>
        record.kind === "turn" &&
        record.phase !== "started" &&
        record.phase !== "completed"
          ? [record.turnId]
          : [],
      ),
    );
    const arrived: string[] = [];
    for (const message of messages) {
      const record =
        message.sequence === undefined
          ? undefined
          : bySequence.get(message.sequence);
      if (
        message.role === "user" &&
        (message.stopped || (record && unsuccessful.has(record.turnId)))
      ) {
        this.pending.delete(message.id);
      }
    }
    for (const message of messages) {
      const requestId = message.requestId;
      if (
        message.role !== "assistant" ||
        !requestId ||
        !this.pending.has(requestId)
      )
        continue;
      const record =
        message.sequence === undefined
          ? undefined
          : bySequence.get(message.sequence);
      // Optimistic error/cancel bubbles and synthetic terminal notices are not replies.
      if (!record || record.kind !== "message" || record.role !== "assistant")
        continue;
      if (
        message.stopped ||
        unsuccessful.has(record.turnId) ||
        record.payload.isError === true ||
        record.payload.stopReason === "error" ||
        record.payload.stopReason === "aborted"
      ) {
        this.pending.delete(requestId);
        continue;
      }
      if (
        record.hidden ||
        hasToolCalls(record.payload) ||
        !message.text.trim() ||
        !cloudTurnActivity(records, record.turnId).answerLanded
      )
        continue;
      this.pending.delete(requestId);
      arrived.push(requestId);
    }
    return arrived;
  }
}
