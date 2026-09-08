/**
 * Reply context: when a reply affordance earns its place in the timeline.
 *
 * A reply reference exists to bridge distance. When Stella answers the
 * message directly above, or reports on the task the reader is already
 * looking at, a quote bubble pointing at it is noise. This module is the one
 * rule both clients apply to the persisted references (which stay intact for
 * lineage and focus) to decide what the timeline actually shows:
 *
 *   - `contexts`: for each assistant row, the single reference worth quoting
 *     above it — the first one that reaches outside the current exchange. A
 *     task reference beats a message reference beside it (it is more
 *     specific: the message is the ask, the task is the work).
 *   - `counts`: how many *distant* replies cite each target. This feeds the
 *     "N replies" badge under an original message, so scrolling back to an
 *     ask shows how much came back later and opens the whole chain. Adjacent
 *     replies are not counted; a badge that duplicates the bubble right
 *     below it says nothing. A reply that reports on a task counts for the
 *     ask that spawned the task: from the user's side the task *is* the
 *     ask, and completions cite the task rather than the message.
 *   - `agentOrigins`: which ask each task came from, for the same reason —
 *     a focused chain rooted on a message also carries its tasks' updates.
 *
 * The "current exchange" is everything since the last visible user message:
 * that ask, and every reply, citation, and task that followed it. A reply
 * that answers an earlier ask (a same-turn final reply landing after the
 * user interjected) rejoins that ask's exchange, so a later citation of that
 * work stays quiet too.
 */
import type { ReplyCounts, ReplyRef } from "@stella/contracts/reply-refs";

export type ReplyContextRow = {
  id: string;
  role: "user" | "assistant";
  /**
   * Not shown to the user (a runtime wake prompt such as `[Agent completed]`).
   * A hidden user row does not start a new exchange: the reply after it
   * still belongs to whatever the reader was last looking at.
   */
  hidden?: boolean;
  /** Other ids this row is known by (a reconciled canonical id, for one). */
  aliasIds?: readonly string[];
  /** Persisted reply references (assistant rows only). */
  refs?: readonly ReplyRef[];
  /** Message ids this assistant row answers (its turn's user message). */
  answersMessageIds?: readonly string[];
  /**
   * Agent threads this row introduced (spawn cards, inline work, or the
   * spawn tool call anchored on a user message). On a user row they belong
   * to that ask's exchange from the start.
   */
  ownsAgentIds?: readonly string[];
};

export type ReplyContextProjection = {
  /** One quotable reference per assistant row that reaches outside its exchange. */
  contexts: ReadonlyMap<string, ReplyRef>;
  /** Distant replies per cited target; drives the "N replies" badge. */
  counts: ReplyCounts;
  /** Agent thread id → id of the user message whose turn spawned it. */
  agentOrigins: ReadonlyMap<string, string>;
};

export const replyRefKey = (ref: ReplyRef): string =>
  ref.kind === "agent" ? `a:${ref.threadId}` : `m:${ref.id}`;

const messageKey = (id: string) => `m:${id}`;
const agentKey = (id: string) => `a:${id}`;

export function projectReplyContexts(
  rows: readonly ReplyContextRow[],
): ReplyContextProjection {
  const contexts = new Map<string, ReplyRef>();
  const counts: ReplyCounts = { messages: {}, agents: {} };
  const agentOrigins = new Map<string, string>();
  /** Each ask's exchange, shared by reference under every id it is known by. */
  const exchanges = new Map<string, Set<string>>();
  let context = new Set<string>();
  let exchangeUserId: string | null = null;
  const bump = (bucket: Record<string, number>, key: string) => {
    bucket[key] = (bucket[key] ?? 0) + 1;
  };
  for (const row of rows) {
    if (row.hidden) continue;
    if (row.role === "user") {
      exchangeUserId = row.id;
      context = new Set([messageKey(row.id)]);
      exchanges.set(row.id, context);
      for (const alias of row.aliasIds ?? []) {
        context.add(messageKey(alias));
        exchanges.set(alias, context);
      }
      for (const id of row.ownsAgentIds ?? []) {
        context.add(agentKey(id));
        agentOrigins.set(id, row.id);
      }
      continue;
    }
    const answers = row.answersMessageIds ?? [];
    // A reply to an earlier ask rejoins that ask's exchange.
    const rejoined = answers
      .map((id) => exchanges.get(id))
      .filter((set): set is Set<string> => Boolean(set) && set !== context);
    for (const prior of rejoined) for (const key of prior) context.add(key);
    // A later `send_input` re-activation moves the task to the ask that
    // steered it, so its next report counts for that ask.
    const origin = answers.find((id) => exchanges.has(id)) ?? exchangeUserId;
    if (origin) {
      for (const id of row.ownsAgentIds ?? []) agentOrigins.set(id, origin);
    }
    const refs = row.refs ?? [];
    const distant = refs.filter((ref) => !context.has(replyRefKey(ref)));
    const candidates = distant.some((ref) => ref.kind === "agent")
      ? distant.filter((ref) => ref.kind === "agent")
      : distant;
    const visible = candidates[0];
    if (visible) contexts.set(row.id, visible);
    const countedMessages = new Set<string>();
    for (const ref of distant) {
      if (ref.kind === "message") {
        countedMessages.add(ref.id);
        continue;
      }
      bump(counts.agents, ref.threadId);
      const ask = agentOrigins.get(ref.threadId);
      if (ask) countedMessages.add(ask);
    }
    // One reply counts once per ask, even when it cites both the ask and
    // the task it spawned.
    for (const id of countedMessages) bump(counts.messages, id);
    const added = [messageKey(row.id)];
    for (const alias of row.aliasIds ?? []) added.push(messageKey(alias));
    for (const ref of refs) added.push(replyRefKey(ref));
    for (const id of answers) added.push(messageKey(id));
    for (const id of row.ownsAgentIds ?? []) added.push(agentKey(id));
    for (const key of added) {
      context.add(key);
      for (const prior of rejoined) prior.add(key);
    }
  }
  return { contexts, counts, agentOrigins };
}

/**
 * Whether a task title names a thread id. The orchestrator picks thread ids
 * as slugs of the task description ("Pricing research" → `pricing-research`),
 * so a spawn that only recorded its description can still be matched to the
 * thread a later report cites when no title map is available.
 */
/**
 * Whether a task title names a thread id. Desktop-run threads are keyed by
 * the slug of their description plus a short random tail
 * (`create-report-k3f9qz`); older ones were the bare slug. Either form names
 * the thread whose description slugs the same way.
 */
export const titleNamesThread = (title: string, threadId: string): boolean => {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/^(?:agent|thread):/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const a = slug(title);
  const b = slug(threadId);
  if (a.length === 0) return false;
  if (a === b) return true;
  return b.startsWith(`${a}-`) && /^[a-z0-9]{6}$/.test(b.slice(a.length + 1));
};

/** Reply count for a message known by any of the given ids. */
export const replyCountFor = (
  counts: ReplyCounts,
  ids: readonly (string | undefined)[],
): number => {
  let total = 0;
  for (const id of ids) if (id) total += counts.messages[id] ?? 0;
  return total;
};
