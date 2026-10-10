/**
 * The `message #N` id each user message reaches the model with: its seq in
 * the conversation's record (the journal, or the chat log of a conversation
 * kept on this computer), which `refs` replies and reactions cite.
 *
 * A message written from the record carries its seq as a part mark. One sent
 * here gets its seq only once a mirror records it (the journal's begin, the
 * chat log's write), so the mirrors note it by the message's client id in
 * `StellaMessageIdsDoc`. `messageIdsHook` appends the tag to each request's
 * copy of the message; the transcript keeps the user's text as sent.
 */
import type { Context } from "@earendil-works/chord";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { defineDoc, GenerationTask, hook, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { piUserHidden, type PiPartMarks, type PiUserMessage } from "@stella/contracts/pi-chat";
import { appendMessageRefTag, formatMessageRefTag } from "@stella/contracts/reply-refs";

/** The newest ids kept: far more user messages than any context window holds. */
const MAX_IDS = 2_000;
/** How long a request waits for a mirror to record the seq of a message just sent. */
const RECORD_WAIT_MS = 5_000;
const RECORD_POLL_MS = 50;
const TAGGED_RE = /<system-reminder>message #\d+<\/system-reminder>/;

/** A message the record could not number (its begin was refused): requests stop waiting for it. */
export const NO_MESSAGE_ID = -1;

/** Seqs of the messages sent here, by client id. */
export const StellaMessageIdsDoc = defineDoc<{ ids: Record<string, number> }>({
  kind: "stella.message-ids",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ ids: {} }),
});

/** Note the seq the conversation's record gave the message sent with `clientMsgId`, or `NO_MESSAGE_ID`. */
export async function recordMessageId(
  harness: Harness,
  conversationId: ConversationId,
  clientMsgId: string,
  seq: number,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(StellaMessageIdsDoc, conversationId);
    if (doc.ids[clientMsgId] === seq || (seq === NO_MESSAGE_ID && doc.ids[clientMsgId] !== undefined)) return undefined;
    doc.ids[clientMsgId] = seq;
    const keys = Object.keys(doc.ids);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_IDS))) delete doc.ids[key];
    return undefined;
  }, context);
}

const marksOf = (message: UserMessage): PiPartMarks[] =>
  typeof message.content === "string"
    ? []
    : message.content.flatMap((part) => {
        const marks = (part as { stella?: PiPartMarks }).stella;
        return marks ? [marks] : [];
      });

const textOf = (message: UserMessage): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** A message the user wrote that has no tag yet: its seq mark and client id. */
const untagged = (message: Message): { seq?: number; clientMsgId?: string } | undefined => {
  if (message.role !== "user" || piUserHidden(message as PiUserMessage) || TAGGED_RE.test(textOf(message))) {
    return undefined;
  }
  const marks = marksOf(message);
  const seq = marks.find((mark) => typeof mark.seq === "number")?.seq;
  const clientMsgId = marks.find((mark) => typeof mark.clientMsgId === "string")?.clientMsgId;
  if (seq === undefined && clientMsgId === undefined) return undefined;
  return { ...(seq === undefined ? {} : { seq }), ...(clientMsgId ? { clientMsgId } : {}) };
};

/** The message with its tag after its last text part. */
const tagged = (message: UserMessage, seq: number): UserMessage => {
  if (typeof message.content === "string") return { ...message, content: appendMessageRefTag(message.content, seq) };
  const at = message.content.findLastIndex((part) => part.type === "text" && part.text.trim().length > 0);
  if (at < 0) return { ...message, content: [...message.content, { type: "text", text: formatMessageRefTag(seq) }] };
  return {
    ...message,
    content: message.content.map((part, index) =>
      index === at && part.type === "text" ? { ...part, text: appendMessageRefTag(part.text, seq) } : part,
    ),
  };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const messageIdsHook = hook(GenerationTask, {
  beforeRequest: async (request, api, context) => {
    const pending = request.messages.map(untagged);
    if (!pending.some(Boolean)) return undefined;
    const read = async () => (await api.snapshot(StellaMessageIdsDoc, api.conversationId, context))?.ids ?? {};
    let ids = await read();
    // The messages this run answers were just sent: their mirror records them a moment later.
    const lastAnswered = request.messages.findLastIndex((message) => message.role === "assistant");
    const waitFor = pending.flatMap((entry, index) =>
      index > lastAnswered && entry?.seq === undefined && entry?.clientMsgId && ids[entry.clientMsgId] === undefined
        ? [entry.clientMsgId]
        : [],
    );
    if (waitFor.length > 0 && (await api.memo<boolean>(`message-ids:${waitFor.join(",")}`, context)) !== true) {
      for (let waited = 0; waited < RECORD_WAIT_MS && waitFor.some((id) => ids[id] === undefined); waited += RECORD_POLL_MS) {
        await sleep(RECORD_POLL_MS);
        ids = await read();
      }
      await api.memo(`message-ids:${waitFor.join(",")}`, true, context);
    }
    let changed = false;
    const messages = request.messages.map((message, index) => {
      const entry = pending[index];
      const seq = entry?.seq ?? (entry?.clientMsgId ? ids[entry.clientMsgId] : undefined);
      if (seq === undefined || seq === NO_MESSAGE_ID || message.role !== "user") return message;
      changed = true;
      return tagged(message, seq);
    });
    return changed ? { messages } : undefined;
  },
});
