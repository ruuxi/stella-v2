import type { DispatchSummary } from "@stella/contracts/turn-plane/placement";

/**
 * Whether a dispatch this desktop submitted has been handed to Stella's cloud.
 *
 * The owner gate starts the conversation's own Durable Object turn, records
 * its id on the row, and never settles the dispatch afterwards: from there the
 * turn is tracked over the conversation socket, exactly as the web shell does
 * once `cloudTurnId` appears. A desktop that kept waiting for a terminal
 * dispatch state would poll the gate forever and never finish its placed run.
 */
/** A send whose dispatch this desktop is still submitting. */
export type SubmittingPlacement = { conversationId: string; stopped: boolean };

/**
 * What a conversation runs elsewhere because this desktop placed it, so Stop
 * reaches it at any point: a send still being submitted (no dispatch id yet)
 * is marked and canceled the moment its id arrives, and a dispatch already
 * placed is canceled by its exact id until it is known to have ended. A
 * conversation-wide cancel is never sent: it could stop a newer turn.
 */
export class ConversationPlacements {
  readonly #submitting = new Set<SubmittingPlacement>();
  readonly #placed = new Map<string, Set<string>>();

  submitting(conversationId: string): SubmittingPlacement {
    const entry: SubmittingPlacement = { conversationId, stopped: false };
    this.#submitting.add(entry);
    return entry;
  }

  submitted(entry: SubmittingPlacement, dispatchId?: string): void {
    this.#submitting.delete(entry);
    if (dispatchId) this.placed(entry.conversationId, dispatchId);
  }

  placed(conversationId: string, dispatchId: string): void {
    const ids = this.#placed.get(conversationId) ?? new Set<string>();
    ids.add(dispatchId);
    this.#placed.set(conversationId, ids);
  }

  /** Placed dispatches of a conversation, besides `except`. */
  placedIn(conversationId: string, except?: string): string[] {
    return [...(this.#placed.get(conversationId) ?? [])].filter((id) => id !== except);
  }

  ended(dispatchId: string): void {
    for (const [conversationId, ids] of this.#placed) {
      if (ids.delete(dispatchId) && ids.size === 0) this.#placed.delete(conversationId);
    }
  }

  /** Stop: marks the conversation's sends still submitting, and returns its placed dispatches. */
  stop(conversationId: string): string[] {
    for (const entry of this.#submitting) {
      if (entry.conversationId === conversationId) entry.stopped = true;
    }
    return this.placedIn(conversationId);
  }

  clear(): void {
    for (const entry of this.#submitting) entry.stopped = true;
    this.#submitting.clear();
    this.#placed.clear();
  }
}

const TERMINAL_DISPATCH_STATES = new Set(["completed", "failed", "canceled", "blocked"]);

export const isDispatchEnded = (status: Pick<DispatchSummary, "state"> | null | undefined): boolean =>
  !status || TERMINAL_DISPATCH_STATES.has(status.state);

export const isCloudHandedOff = (
  status: Pick<DispatchSummary, "placement" | "cloudTurnId"> | null | undefined,
): boolean =>
  Boolean(
    status &&
      status.placement === "cloud" &&
      typeof status.cloudTurnId === "string" &&
      status.cloudTurnId.trim(),
  );
