/**
 * Reply references: the orchestrator's way of saying what a reply is about.
 *
 * The model ends a reply with a fenced block tagged `refs`, one target per
 * line. Messages are cited by their conversation sequence number (`#142`),
 * agents by their durable thread id (`agent:pricing-research`). The block is
 * stripped from every user-facing copy of the text and resolved against the
 * conversation before it is stored; the model's own thread history keeps the
 * block verbatim so it can see its previous usage.
 *
 *   ```refs
 *   #142
 *   agent:pricing-research
 *   ```
 *
 * The model learns message numbers from a trailing `<system-reminder>` tag on
 * each user turn (`formatMessageRefTag`), the same channel the timestamp tag
 * already uses.
 */
import { SYSTEM_REMINDER_TAG } from "@stella/contracts/system-reminders";

export const REPLY_REFS_FENCE_TAG = "refs";

/** A citation as the model wrote it, before validation. */
export type RawReplyRef =
  | { kind: "message"; sequence: number }
  | { kind: "agent"; threadId: string };

/** A citation that resolved against the conversation. */
export type ReplyRef =
  | {
      kind: "message";
      /** Conversation sequence number the model cited. */
      sequence: number;
      /** Durable entry id of the cited message. */
      id: string;
      /** Role of the cited message; drives the preview bubble style. */
      role: "user" | "assistant";
      /** Bounded plain-text excerpt of the cited message. */
      preview: string;
    }
  | {
      kind: "agent";
      threadId: string;
      /** Task description at the time the reply was stored. */
      title: string;
    };

const FENCE_RE = new RegExp(
  `(?:^|\\n)[ \\t]*(\`{3,}|~{3,})[ \\t]*${REPLY_REFS_FENCE_TAG}[ \\t]*\\n([\\s\\S]*?)\\n?[ \\t]*\\1[ \\t]*$`,
);

export type ReplyReaction = { sequence: number; emoji: string };

export type MessageReaction = { emoji: string; at: number };

const REACTION_LINE_RE =
  /^react(?:ion)?s?\s*[:=]?\s*(?:#|m(?:essage)?\s*#?)?\s*(\d{1,9})\s*[:=]?\s*(\S+)$/i;
const EMOJI_CHAR_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{3030}\u{303D}\u{3297}\u{3299}\u{00A9}\u{00AE}\u{203C}\u{2049}\u{2122}\u{2139}\u{20E3}]/u;
const MAX_REACTION_CHARS = 32;

const normalizeReactionEmoji = (value: string): string | null => {
  const emoji = value.trim().replace(/^[`'"]+|[`'"]+$/g, "");
  if (!emoji || emoji.length > MAX_REACTION_CHARS) return null;
  if (!EMOJI_CHAR_RE.test(emoji) || /[A-Za-z]/.test(emoji)) return null;
  return emoji;
};

const parseReactionLine = (line: string): ReplyReaction | null => {
  const match = REACTION_LINE_RE.exec(line);
  if (!match) return null;
  const sequence = Number.parseInt(match[1]!, 10);
  const emoji = normalizeReactionEmoji(match[2]!);
  return Number.isSafeInteger(sequence) && sequence >= 0 && emoji
    ? { sequence, emoji }
    : null;
};

export const readMessageReaction = (
  payload: unknown,
): MessageReaction | null => {
  if (!payload || typeof payload !== "object") return null;
  const reaction = (payload as { reaction?: unknown }).reaction;
  if (!reaction || typeof reaction !== "object") return null;
  const { emoji, at } = reaction as { emoji?: unknown; at?: unknown };
  if (typeof emoji !== "string") return null;
  const normalized = normalizeReactionEmoji(emoji);
  return normalized
    ? { emoji: normalized, at: typeof at === "number" ? at : 0 }
    : null;
};

const MESSAGE_LINE_RE = /^(?:#|m(?:essage)?\s*#?)\s*(\d{1,9})$/i;
const AGENT_LINE_RE = /^(?:agent|thread|thread_id)\s*[:=]\s*(.+)$/i;
const BARE_AGENT_LINE_RE = /^[a-z0-9][a-z0-9_.-]{0,199}$/i;

const parseRefLine = (line: string): RawReplyRef | null => {
  const trimmed = line
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/[,;]$/, "");
  if (!trimmed) return null;
  const message = MESSAGE_LINE_RE.exec(trimmed);
  if (message) {
    const sequence = Number.parseInt(message[1]!, 10);
    return Number.isSafeInteger(sequence) && sequence > 0
      ? { kind: "message", sequence }
      : null;
  }
  const agent = AGENT_LINE_RE.exec(trimmed);
  if (agent) {
    const threadId = agent[1]!.trim().replace(/^[`'"]|[`'"]$/g, "");
    return threadId ? { kind: "agent", threadId } : null;
  }
  if (BARE_AGENT_LINE_RE.test(trimmed)) {
    return { kind: "agent", threadId: trimmed };
  }
  return null;
};

/**
 * Split a reply into its user-facing text and the citations it carried.
 * Only a trailing fence counts; a `refs` block quoted mid-message stays as
 * text. A malformed block is still removed so it never reaches the user.
 */
export const splitReplyRefs = (
  text: string,
): { text: string; refs: RawReplyRef[]; reactions: ReplyReaction[] } => {
  const trimmedEnd = text.replace(/\s+$/, "");
  const match = FENCE_RE.exec(trimmedEnd);
  if (!match || match.index === undefined) {
    return { text, refs: [], reactions: [] };
  }
  const body = match[2] ?? "";
  const seen = new Set<string>();
  const refs: RawReplyRef[] = [];
  const reactionsBySequence = new Map<number, ReplyReaction>();
  for (const line of body.split(/\r?\n/)) {
    const cleaned = line
      .trim()
      .replace(/^[-*•]\s+/, "")
      .replace(/[,;]$/, "");
    const reaction = parseReactionLine(cleaned);
    if (reaction) {
      reactionsBySequence.delete(reaction.sequence);
      reactionsBySequence.set(reaction.sequence, reaction);
      continue;
    }
    if (/^react/i.test(cleaned)) continue;
    const ref = parseRefLine(line);
    if (!ref) continue;
    const key =
      ref.kind === "message" ? `m:${ref.sequence}` : `a:${ref.threadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  const stripped = trimmedEnd.slice(0, match.index).replace(/\s+$/, "");
  return { text: stripped, refs, reactions: [...reactionsBySequence.values()] };
};

/** Trailing tag that tells the model a user message's sequence number. */
export const formatMessageRefTag = (sequence: number): string =>
  `<${SYSTEM_REMINDER_TAG}>message #${sequence}</${SYSTEM_REMINDER_TAG}>`;

export const MESSAGE_REF_TAG_RE = new RegExp(
  `\\s*<${SYSTEM_REMINDER_TAG}>message #\\d+<\\/${SYSTEM_REMINDER_TAG}>`,
  "gi",
);

/** Append the sequence tag to a user prompt that will reach the model. */
export const appendMessageRefTag = (text: string, sequence: number): string => {
  const body = text.replace(/\s+$/, "");
  if (!body) return text;
  return `${body}\n\n${formatMessageRefTag(sequence)}`;
};

/** Remove the sequence tag from any user-facing copy of a user message. */
export const stripMessageRefTag = (text: string): string =>
  text.replace(MESSAGE_REF_TAG_RE, "");

/** Root of a focus (lineage) view: one message or one agent thread. */
export type ConversationFocusRoot =
  | { kind: "message"; id: string }
  | { kind: "agent"; threadId: string };

/** Reply counts per referenced target, for the "N replies" affordance. */
export type ReplyCounts = {
  /** Keyed by the cited message's entry id. */
  messages: Record<string, number>;
  /** Keyed by agent thread id. */
  agents: Record<string, number>;
};

const PREVIEW_MAX_CHARS = 160;

/** Collapse a message body to a one-line excerpt for a reply preview. */
export const toReplyPreview = (text: string): string => {
  const compact = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= PREVIEW_MAX_CHARS) return compact;
  return `${compact.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
};
