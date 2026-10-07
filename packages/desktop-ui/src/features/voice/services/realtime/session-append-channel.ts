/**
 * The two channels Stella uses to put information back into a live GPT-Live
 * session.
 *
 *   - `session.commentary.append` — text the model should SAY. It paraphrases
 *     rather than reading verbatim, so this carries results and anything the
 *     user is waiting to hear.
 *   - `session.thinking.append` — text the model should KNOW but not announce:
 *     progress, facts, context arriving from the text chat.
 *
 * Both take a plain-string `content` capped at `VOICE_APPEND_MAX_CHARS` and a
 * REQUIRED `delegation_id`: the saved delegation id when the append updates a
 * task, or `null` for session-wide context. Longer text is split across
 * several appends here rather than truncated.
 *
 * Acks come back as `session.commentary.appended` / `session.thinking.appended`
 * / `session.instructions.appended`, matched by `client_event_id` against the
 * `event_id` we sent. Error variants settle the same pending entry so a
 * rejected append is logged once instead of waiting forever.
 */

import { VOICE_APPEND_MAX_CHARS } from "@stella/contracts/backend/voice";
import { createClientEventId } from "./transports/webrtc-media-session";

export type SessionAppendKind = "commentary" | "thinking" | "instructions";

const ACK_TIMEOUT_MS = 10_000;
/** Progress notes are a courtesy, not a feed. One every this often, at most. */
const PROGRESS_MIN_INTERVAL_MS = 1_200;

const APPEND_EVENT_TYPE: Record<SessionAppendKind, string> = {
  commentary: "session.commentary.append",
  thinking: "session.thinking.append",
  instructions: "session.instructions.append",
};

const ACK_EVENT_TYPE: Record<SessionAppendKind, string> = {
  commentary: "session.commentary.appended",
  thinking: "session.thinking.appended",
  instructions: "session.instructions.appended",
};

const ACK_TYPES = new Set(Object.values(ACK_EVENT_TYPE));

/**
 * Split on sentence boundaries where possible, then on whitespace, so a long
 * result arrives as several speakable appends instead of one truncated one.
 */
export const splitAppendContent = (
  content: string,
  maxChars = VOICE_APPEND_MAX_CHARS,
): string[] => {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const sentenceBreak = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
    );
    const wordBreak = window.lastIndexOf(" ");
    const cut =
      sentenceBreak > maxChars * 0.5
        ? sentenceBreak + 1
        : wordBreak > maxChars * 0.5
          ? wordBreak
          : maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter((chunk) => chunk.length > 0);
};

type PendingAppend = {
  kind: SessionAppendKind;
  timer: ReturnType<typeof setTimeout>;
};

export class SessionAppendChannel {
  private readonly pending = new Map<string, PendingAppend>();
  private lastProgressAt = 0;

  constructor(
    private readonly send: (event: Record<string, unknown>) => void,
  ) {}

  /**
   * Queue an append. `delegationId` is null for session-wide context and the
   * saved delegation id for an update about that task.
   */
  append(
    kind: SessionAppendKind,
    content: string,
    delegationId: string | null,
  ): void {
    for (const chunk of splitAppendContent(content)) {
      const eventId = createClientEventId(`voice_${kind}`);
      this.pending.set(eventId, {
        kind,
        timer: setTimeout(() => {
          this.pending.delete(eventId);
        }, ACK_TIMEOUT_MS),
      });
      this.send({
        type: APPEND_EVENT_TYPE[kind],
        event_id: eventId,
        content: chunk,
        delegation_id: delegationId,
      });
    }
  }

  /**
   * A rate-limited `thinking` append for in-flight progress, so the model can
   * truthfully say what is happening without being flooded.
   */
  appendProgress(content: string, delegationId: string | null): boolean {
    const now = Date.now();
    if (now - this.lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return false;
    const trimmed = content.trim();
    if (!trimmed) return false;
    this.lastProgressAt = now;
    this.append("thinking", trimmed, delegationId);
    return true;
  }

  /** Lets the next progress note through regardless of the interval. */
  resetProgressThrottle(): void {
    this.lastProgressAt = 0;
  }

  /** True when the event was an ack/error for one of our appends. */
  handleEvent(event: Record<string, unknown>): boolean {
    const type = typeof event.type === "string" ? event.type : "";
    if (!type.startsWith("session.")) return false;

    const clientEventId =
      typeof event.client_event_id === "string" ? event.client_event_id : null;
    if (!clientEventId) return false;

    const entry = this.pending.get(clientEventId);
    if (!entry) return false;

    if (ACK_TYPES.has(type)) {
      this.settle(clientEventId);
      return true;
    }

    // Error variants of the same three events, plus a generic session error
    // that names our client_event_id.
    if (type.includes("error") || type === "session.error") {
      console.debug(
        `[gpt-live] ${entry.kind} append was rejected:`,
        appendErrorMessage(event),
      );
      this.settle(clientEventId);
      return true;
    }
    return false;
  }

  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.lastProgressAt = 0;
  }

  private settle(eventId: string): void {
    const entry = this.pending.get(eventId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(eventId);
  }
}

const appendErrorMessage = (event: Record<string, unknown>): string => {
  const error =
    typeof event.error === "object" && event.error !== null
      ? (event.error as Record<string, unknown>)
      : null;
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof event.message === "string" && event.message.trim()) {
    return event.message.trim();
  }
  return "no reason given";
};
