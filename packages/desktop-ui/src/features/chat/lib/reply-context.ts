import type { EventRowViewModel, UserRowViewModel } from "../conversation-row-types";
import {
  projectReplyContexts,
  replyCountFor,
  titleNamesThread,
  type ReplyContextRow,
} from "@stella/contracts/reply-context";

export type ReplyContextOptions = {
  /**
   * Task titles by thread id from the runtime's Activity list. The
   * authoritative source when the transcript itself carries no title for a
   * spawn (a locally executed turn mirrored into the cloud journal).
   */
  agentTitles?: ReadonlyMap<string, string>;
};

/**
 * A user row that paints nothing (a runtime wake prompt whose text is
 * withheld, with no attachments or context chips) is not a new ask.
 */
const rendersNothing = (row: UserRowViewModel): boolean =>
  !row.text.trim() &&
  row.attachments.length === 0 &&
  !row.windowLabel &&
  !row.quotedText &&
  !(row.pastedTexts?.length) &&
  !(row.appSelectionLabels?.length) &&
  !row.activityLabel;

/**
 * Apply the shared reply-context rule (`@stella/contracts/reply-context`) to
 * the projected timeline. Persisted references stay intact for lineage and
 * focus; this changes display rows only:
 *   - an assistant row keeps at most one quotable reference, and only when
 *     it reaches outside the exchange the reader is already in;
 *   - a user row learns how many distant replies cite it, for the
 *     "N replies" badge that opens its chain.
 */
export function withReplyContext(
  rows: EventRowViewModel[],
  options: ReplyContextOptions = {},
): EventRowViewModel[] {
  // Task titles the timeline knows, so a spawn that only recorded its
  // description (a local turn mirrored to the cloud journal) still owns the
  // thread a later report cites by that same title.
  const threadIdsByTitle = new Map<string, string[]>();
  const citedThreadIds = new Set<string>();
  const learn = (title: string | undefined, threadId: string) => {
    const key = title?.trim();
    if (!key) return;
    const known = threadIdsByTitle.get(key);
    if (!known) threadIdsByTitle.set(key, [threadId]);
    else if (!known.includes(threadId)) known.push(threadId);
  };
  for (const [threadId, title] of options.agentTitles ?? []) learn(title, threadId);
  for (const row of rows) {
    if (row.kind !== "assistant") continue;
    for (const ref of row.replyRefs ?? []) {
      if (ref.kind !== "agent") continue;
      citedThreadIds.add(ref.threadId);
      learn(ref.title, ref.threadId);
    }
    for (const [threadId, title] of Object.entries(row.backgroundWork?.descriptions ?? {})) {
      learn(title, threadId);
    }
  }
  const ownedAgents = (ids: readonly string[] | undefined, titles: readonly string[] | undefined) => {
    const owned = [...(ids ?? [])];
    for (const title of titles ?? []) {
      for (const threadId of threadIdsByTitle.get(title.trim()) ?? []) {
        if (!owned.includes(threadId)) owned.push(threadId);
      }
      // Last resort: the thread id is the description's slug.
      for (const threadId of citedThreadIds) {
        if (!owned.includes(threadId) && titleNamesThread(title, threadId)) owned.push(threadId);
      }
    }
    return owned;
  };
  const input: ReplyContextRow[] = rows.map((row) => {
    if (row.kind === "user") {
      const owns = ownedAgents(row.spawnedThreadIds, row.spawnedDescriptions);
      return {
        id: row.id,
        role: "user",
        ...(row.hidden || rendersNothing(row) ? { hidden: true } : {}),
        ...(owns.length ? { ownsAgentIds: owns } : {}),
      };
    }
    if (row.kind !== "assistant") return { id: row.id, role: "assistant" };
    const answers: string[] = [];
    if (row.replyToUserMessageId) answers.push(row.replyToUserMessageId);
    if (row.sourceMessageId) answers.push(row.sourceMessageId);
    const ownsAgentIds = ownedAgents(
      [...(row.backgroundWork?.threadIds ?? []), ...(row.spawnedThreadIds ?? [])],
      row.spawnedDescriptions,
    );
    return {
      id: row.id,
      role: "assistant",
      ...(row.replyRefs ? { refs: row.replyRefs } : {}),
      ...(answers.length ? { answersMessageIds: answers } : {}),
      ...(ownsAgentIds.length ? { ownsAgentIds } : {}),
    };
  });
  const { contexts, counts } = projectReplyContexts(input);
  return rows.map((row) => {
    if (row.kind === "user") {
      const replyCount = replyCountFor(counts, [row.id]);
      if (replyCount === (row.replyCount ?? 0)) return row;
      return { ...row, replyCount };
    }
    if (row.kind !== "assistant" || !row.replyRefs?.length) return row;
    const visible = contexts.get(row.id);
    return { ...row, replyRefs: visible ? [visible] : [] };
  });
}
