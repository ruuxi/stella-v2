import type { ReplyRef } from "@stella/contracts/reply-refs";
import {
  projectReplyContexts,
  replyRefKey,
  titleNamesThread,
  type ReplyContextProjection,
  type ReplyContextRow,
} from "@stella/contracts/reply-context";
import type { ChatMessage, ChatArtifact } from "../types";
import type { JournalFile, JournalRecord } from "./cloud-conversation-protocol";
import { cloudFileArtifact } from "./cloud-file-payload";

const WAKE_THREAD_RE = /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?(?:^thread_id:\s*(\S+)|\(thread ([^)]+)\))/mu;
const WAKE_DESCRIPTION_RE = /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?^description:\s*(.+)$/mu;

/**
 * The task named by a hidden lifecycle wake prompt (`[Agent completed]` and
 * friends): its thread id and, when carried, its description. A locally
 * executed turn mirrored into the journal has no lifecycle card, so this is
 * where a cited task's title comes from.
 */
export function lifecycleWakeTask(text: string): { threadId: string; description?: string } | null {
  const match = WAKE_THREAD_RE.exec(text);
  const threadId = (match?.[1] ?? match?.[2])?.trim();
  if (!threadId) return null;
  const description = WAKE_DESCRIPTION_RE.exec(text)?.[1]?.trim();
  return description ? { threadId, description } : { threadId };
}

const SUMMARY_MAX_CHARS = 160;

/**
 * Compact one-line excerpt of a task's result for a fileless completion
 * (desktop parity: the AgentCompletionCard's summary). Block markdown goes,
 * links keep their text, whitespace collapses, and a long result is cut at
 * a word boundary.
 */
export function summaryExcerpt(result: string): string {
  const compact = result
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= SUMMARY_MAX_CHARS) return compact;
  const head = compact.slice(0, SUMMARY_MAX_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace >= SUMMARY_MAX_CHARS - 24 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}…`;
}

const wakeText = (record: JournalRecord): string => {
  if (record.kind !== "message") return "";
  const content = record.payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
};

/**
 * Lifecycle cards onto transcript rows, matching desktop:
 *   - the turn that spawned a task carries the spawn card, which settles
 *     (done / failed) when the task's terminal card arrives;
 *   - the reply that relays a completed task's result carries a completion
 *     card with the task's produced files and a result excerpt;
 *   - files the journal reports under a spawn turn belong to that task, so
 *     they ride its completion card rather than the spawn turn's reply.
 * Rows anchor on the turn's visible replies by journal order, never on a
 * particular reply existing at the moment a card is read.
 */
export function projectMobileLifecycle(messages: ChatMessage[], records: readonly JournalRecord[], conversationId: string): ChatMessage[] {
  const titles = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== "message" || record.role !== "user" || !record.hidden) continue;
    const task = lifecycleWakeTask(wakeText(record));
    if (task?.description && !titles.has(task.threadId)) titles.set(task.threadId, task.description);
  }
  const messagesById = new Map(messages.map(message => [message.id, message]));
  const assistantsByTurn = new Map<string, Array<{ seq: number; message: ChatMessage }>>();
  for (const record of records) {
    if (record.kind !== "message" || record.role !== "assistant" || record.hidden) continue;
    const message = messagesById.get(`cloud:${record.turnId}:message:${record.seq}`);
    if (!message) continue;
    const rows = assistantsByTurn.get(record.turnId) ?? [];
    rows.push({ seq: record.seq, message });
    assistantsByTurn.set(record.turnId, rows);
  }
  /** The reply a card rides: the last one before it, else the first after. */
  const anchorBefore = (turnId: string, seq: number) => {
    const rows = assistantsByTurn.get(turnId) ?? [];
    return rows.filter(row => row.seq < seq).at(-1)?.message ?? rows[0]?.message;
  };
  /** The reply that relays a result: the first one after the card, else the last. */
  const anchorAfter = (turnId: string, seq: number) => {
    const rows = assistantsByTurn.get(turnId) ?? [];
    return rows.find(row => row.seq > seq)?.message ?? rows.at(-1)?.message;
  };
  const attach = (message: ChatMessage, artifacts: ChatArtifact[]) => {
    message.artifacts = [...(message.artifacts ?? []), ...artifacts];
  };

  const starts = new Map<string, ChatArtifact>();
  const agentByTurn = new Map<string, string>();
  const filesByAgent = new Map<string, Array<{ file: JournalFile; createdAt: number }>>();
  const completions: Array<{ eventId: string; agentId: string; turnId: string; seq: number; createdAt: number; result: string }> = [];
  for (const record of records) {
    if (record.kind !== "card") continue;
    if (record.card.type === "files") {
      const agentId = agentByTurn.get(record.turnId);
      if (!agentId) continue;
      const list = filesByAgent.get(agentId) ?? [];
      for (const file of record.card.files) list.push({ file, createdAt: record.createdAtMs });
      filesByAgent.set(agentId, list);
      continue;
    }
    if (record.card.type !== "agent-lifecycle") continue;
    const { event } = record.card;
    const id = event.payload.agentId;
    const key = `${id}:${event.payload.attemptGeneration}`;
    if (event.type === "agent-started") {
      titles.set(id, event.payload.description);
      if (!agentByTurn.has(record.turnId)) agentByTurn.set(record.turnId, id);
      const message = anchorBefore(record.turnId, record.seq);
      if (!message) continue;
      const artifact: ChatArtifact = { id: record.card.eventId, conversationId, payload: {
        kind: "agent-work", agentIds: [id], state: "running", total: 1, completed: 0,
        title: event.payload.description, subtitle: "", createdAt: record.createdAtMs,
        followUp: event.payload.isFollowUp,
      } };
      attach(message, [artifact]);
      starts.set(key, artifact);
    } else if (event.type !== "agent-progress") {
      const artifact = starts.get(key);
      if (artifact?.payload.kind === "agent-work") {
        artifact.payload = { ...artifact.payload, state: "done", completed: event.type === "agent-completed" ? 1 : 0, failed: event.type !== "agent-completed" };
      }
      if (event.type === "agent-completed") {
        completions.push({
          eventId: record.card.eventId, agentId: id, turnId: record.turnId, seq: record.seq,
          createdAt: record.createdAtMs, result: typeof event.payload.result === "string" ? event.payload.result : "",
        });
      }
    }
  }

  const placed = new Set<string>();
  for (const completion of completions) {
    const message = anchorAfter(completion.turnId, completion.seq);
    if (!message) continue;
    const title = titles.get(completion.agentId) || "Task";
    const files = (filesByAgent.get(completion.agentId) ?? []).map(entry => cloudFileArtifact(entry.file, conversationId, entry.createdAt));
    const summary = summaryExcerpt(completion.result);
    const card: ChatArtifact = { id: `${completion.eventId}:completion`, conversationId, payload: {
      kind: "agent-work", state: "done", agentIds: [completion.agentId], total: 1, completed: 1,
      title, subtitle: "", createdAt: completion.createdAt, completion: true,
      agents: [{ agentId: completion.agentId, title, files: files.map(file => file.payload), ...(summary ? { summary } : {}) }],
    } };
    attach(message, [card, ...files]);
    placed.add(completion.agentId);
  }
  // A task's files with no relayed result yet stay on the spawn turn's reply.
  for (const [turnId, agentId] of agentByTurn) {
    if (placed.has(agentId)) continue;
    const files = filesByAgent.get(agentId);
    const message = assistantsByTurn.get(turnId)?.at(-1)?.message;
    if (!files?.length || !message) continue;
    attach(message, files.map(entry => cloudFileArtifact(entry.file, conversationId, entry.createdAt)));
    placed.add(agentId);
  }
  // A spawn that only recorded its description (a locally executed turn
  // mirrored into the journal) still names the task: its description is the
  // thread id's slug.
  const descriptions = messages.flatMap(message => message.spawnedDescriptions ?? []);
  const titleFor = (ref: Extract<ReplyRef, { kind: "agent" }>) =>
    titles.get(ref.threadId) ||
    (ref.title && ref.title !== ref.threadId ? ref.title : "") ||
    descriptions.find(description => titleNamesThread(description, ref.threadId)) ||
    ref.title;
  return messages.map(message => ({ ...message, ...(message.replyRefs ? {
    replyRefs: message.replyRefs.map(ref => ref.kind === "agent" ? { ...ref, title: titleFor(ref) } : ref),
  } : {}) }));
}

/** Lifecycle state of a task as the transcript's work cards last saw it. */
export type MobileAgentState = "running" | "completed" | "error";

export type MobileReplyContexts = ReplyContextProjection & {
  /** Latest known state per agent thread, for the quoted task's status glyph. */
  agentStates: ReadonlyMap<string, MobileAgentState>;
};

/** Threads a row started: spawn cards and spawn tool calls, never a completion card. */
const agentIdsOf = (message: ChatMessage): string[] => {
  const ids: string[] = [...(message.spawnedThreadIds ?? [])];
  for (const artifact of message.artifacts ?? []) {
    if (artifact.payload.kind === "agent-work" && !artifact.payload.completion) {
      for (const id of artifact.payload.agentIds ?? []) if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
};

/**
 * Apply the shared reply-context rule (`@stella/contracts/reply-context`) to
 * the mobile transcript. Same outcome as desktop: one quotable reference per
 * assistant row that reaches outside its exchange, and a distant-reply count
 * per original message for the "N replies" badge.
 */
/**
 * Agent threads each row owns: spawned by thread id, or by a spawn
 * description matched to a task title the transcript knows (a cited title,
 * a work card, or the thread id's slug). One rule for reply context and the
 * focused chain, so the badge and the chain agree.
 */
export function mobileOwnedAgentIds(messages: readonly ChatMessage[]): (message: ChatMessage) => string[] {
  const threadIdsByTitle = new Map<string, string[]>();
  const citedThreadIds = new Set<string>();
  const learn = (title: string | undefined, threadId: string) => {
    const key = title?.trim();
    if (!key) return;
    const known = threadIdsByTitle.get(key) ?? [];
    if (!known.includes(threadId)) known.push(threadId);
    threadIdsByTitle.set(key, known);
  };
  for (const message of messages) {
    for (const ref of message.replyRefs ?? []) {
      if (ref.kind !== "agent") continue;
      citedThreadIds.add(ref.threadId);
      learn(ref.title, ref.threadId);
    }
    for (const artifact of message.artifacts ?? []) {
      if (artifact.payload.kind !== "agent-work") continue;
      for (const id of artifact.payload.agentIds ?? []) learn(artifact.payload.title, id);
    }
  }
  return (message: ChatMessage) => {
    const owned = agentIdsOf(message);
    for (const title of message.spawnedDescriptions ?? []) {
      for (const id of threadIdsByTitle.get(title.trim()) ?? []) if (!owned.includes(id)) owned.push(id);
      // Last resort: the thread id is the description's slug.
      for (const id of citedThreadIds) if (!owned.includes(id) && titleNamesThread(title, id)) owned.push(id);
    }
    return owned;
  };
}

export function mobileReplyContexts(messages: readonly ChatMessage[]): MobileReplyContexts {
  const agentStates = new Map<string, MobileAgentState>();
  const ownedAgents = mobileOwnedAgentIds(messages);
  const rows: ReplyContextRow[] = messages.map(message => {
    const aliasIds = message.canonicalId ? [message.canonicalId] : undefined;
    if (message.role === "user") return { id: message.id, role: "user", ...(aliasIds ? { aliasIds } : {}) };
    for (const artifact of message.artifacts ?? []) {
      if (artifact.payload.kind !== "agent-work") continue;
      const state: MobileAgentState = artifact.payload.state === "running" ? "running" : artifact.payload.failed ? "error" : "completed";
      for (const id of artifact.payload.agentIds ?? []) agentStates.set(id, state);
    }
    const ownsAgentIds = ownedAgents(message);
    return {
      id: message.id,
      role: "assistant",
      ...(aliasIds ? { aliasIds } : {}),
      ...(message.replyRefs ? { refs: message.replyRefs } : {}),
      ...(message.requestId ? { answersMessageIds: [message.requestId] } : {}),
      ...(ownsAgentIds.length ? { ownsAgentIds } : {}),
    };
  });
  const projection = projectReplyContexts(rows);
  return { ...projection, agentStates };
}

/**
 * The focused chain for one root. A task root: the turn that spawned it and
 * every reply citing it. A message root: the ask, its own turn's replies,
 * every reply citing it, and every update on the tasks that turn spawned.
 */
export function mobileReplyLineage(messages: readonly ChatMessage[], root: ReplyRef): ChatMessage[] {
  const isRootMessage = (message: ChatMessage) => root.kind === "message" && (message.id === root.id || message.canonicalId === root.id);
  const rootIds = new Set<string>();
  if (root.kind === "message") {
    rootIds.add(root.id);
    for (const message of messages) if (isRootMessage(message)) { rootIds.add(message.id); if (message.canonicalId) rootIds.add(message.canonicalId); }
  }
  const turnOf = (message: ChatMessage) => root.kind === "message" && Boolean(message.requestId) && rootIds.has(message.requestId!);
  const ownAgentIds = new Set<string>();
  if (root.kind === "message") {
    const ownedAgents = mobileOwnedAgentIds(messages);
    for (const message of messages) if (turnOf(message)) for (const id of ownedAgents(message)) ownAgentIds.add(id);
  }
  const cites = (ref: ReplyRef) => root.kind === "agent"
    ? replyRefKey(ref) === replyRefKey(root)
    : (ref.kind === "message" && rootIds.has(ref.id)) || (ref.kind === "agent" && ownAgentIds.has(ref.threadId));
  const owns = (message: ChatMessage) => root.kind === "agent"
    ? message.artifacts?.some(a => a.payload.kind === "agent-work" && a.payload.agentIds?.includes(root.threadId))
    : isRootMessage(message) || turnOf(message);
  const selected = messages.filter(m => owns(m) || m.replyRefs?.some(cites));
  const userIds = new Set(selected.filter(m => owns(m)).map(m => m.requestId));
  const selectedIds = new Set(selected.map(message => message.id));
  return messages.filter(m => selectedIds.has(m.id) || userIds.has(m.id) || (Boolean(m.canonicalId) && userIds.has(m.canonicalId)));
}

/** Desktop-executed turns persist resolved refs instead of a model fence. */
export function resolvedMobileReplyRefs(payload: Record<string, unknown>): ReplyRef[] {
  const metadata = payload.metadata;
  if (!metadata || typeof metadata !== "object" || !("runtime" in metadata)) return [];
  const runtime = metadata.runtime;
  if (!runtime || typeof runtime !== "object" || !("replyRefs" in runtime) || !Array.isArray(runtime.replyRefs)) return [];
  return runtime.replyRefs.flatMap((ref: unknown): ReplyRef[] => {
    if (!ref || typeof ref !== "object" || !("kind" in ref)) return [];
    if (ref.kind === "agent" && "threadId" in ref && typeof ref.threadId === "string") {
      return [{ kind: "agent", threadId: ref.threadId, title: "title" in ref && typeof ref.title === "string" ? ref.title : "" }];
    }
    if (ref.kind === "message" && "id" in ref && typeof ref.id === "string" && "sequence" in ref && typeof ref.sequence === "number" && "role" in ref && (ref.role === "user" || ref.role === "assistant")) {
      return [{ kind: "message", id: ref.id, sequence: ref.sequence, role: ref.role, preview: "preview" in ref && typeof ref.preview === "string" ? ref.preview : "" }];
    }
    return [];
  });
}
