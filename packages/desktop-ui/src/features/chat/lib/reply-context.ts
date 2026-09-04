import type { EventRowViewModel } from "../conversation-row-types";
import type { ReplyRef } from "@stella/contracts/reply-refs";

const refKey = (ref: ReplyRef) => ref.kind === "agent" ? `a:${ref.threadId}` : `m:${ref.id}`;

/** Keep navigation only when a reply returns to work outside the current exchange.
 * Persisted references stay intact for lineage; this changes display rows only. */
export function withReplyContext(rows: EventRowViewModel[]): EventRowViewModel[] {
  let context = new Set<string>();
  return rows.map(row => {
    if (row.kind === "user") {
      context = new Set([`m:${row.id}`]);
      return row;
    }
    if (row.kind !== "assistant") return row;
    const refs = row.replyRefs ?? [];
    // A task reference is more specific than the user message quoted beside it.
    const candidates = refs.some(ref => ref.kind === "agent")
      ? refs.filter(ref => ref.kind === "agent") : refs;
    const visible = candidates.find(ref => !context.has(refKey(ref)));
    const next = new Set<string>();
    for (const ref of refs) next.add(refKey(ref));
    if (row.replyToUserMessageId) next.add(`m:${row.replyToUserMessageId}`);
    if (row.sourceMessageId) next.add(`m:${row.sourceMessageId}`);
    for (const id of row.backgroundWork?.threadIds ?? []) next.add(`a:${id}`);
    // Same-turn preambles and their answers share the work they introduced.
    if (row.isIntraTurn || (row.replyToUserMessageId && context.has(`m:${row.replyToUserMessageId}`))) {
      for (const key of context) next.add(key);
    }
    context = next;
    return refs.length ? { ...row, replyRefs: visible ? [visible] : [] } : row;
  });
}
