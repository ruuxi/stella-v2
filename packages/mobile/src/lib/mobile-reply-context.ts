import type { ReplyRef } from "@stella/contracts/reply-refs";
import {
  projectReplyContexts,
  replyRefKey,
  titleNamesThread,
  type ReplyContextProjection,
  type ReplyContextRow,
} from "@stella/contracts/reply-context";
import type { ChatMessage, ChatArtifact } from "../types";
import type { JournalRecord } from "./cloud-conversation-protocol";

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

export function projectMobileLifecycle(messages: ChatMessage[], records: readonly JournalRecord[], conversationId: string): ChatMessage[] {
  const titles = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== "message" || record.role !== "user" || !record.hidden) continue;
    const content = record.payload.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map(block => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "").join("\n") : "";
    const task = lifecycleWakeTask(text);
    if (task?.description && !titles.has(task.threadId)) titles.set(task.threadId, task.description);
  }
  const starts = new Map<string, ChatArtifact>();
  const messagesById = new Map(messages.map(message => [message.id, message]));
  const latestAssistantByTurn = new Map<string, ChatMessage>();
  for (const record of records) {
    if (record.kind === "message" && record.role === "assistant" && !record.hidden) {
      const message = messagesById.get(`cloud:${record.turnId}:message:${record.seq}`);
      if (message) latestAssistantByTurn.set(record.turnId, message);
    }
    if (record.kind !== "card" || record.card.type !== "agent-lifecycle") continue;
    const { event } = record.card;
    const id = event.payload.agentId;
    const key = `${id}:${event.payload.attemptGeneration}`;
    if (event.type === "agent-started") {
      titles.set(id, event.payload.description);
      const message = latestAssistantByTurn.get(record.turnId);
      if (!message) continue;
      const artifact: ChatArtifact = { id: record.card.eventId, conversationId, payload: {
        kind: "agent-work", agentIds: [id], state: "running", total: 1, completed: 0,
        title: event.payload.description, subtitle: "", createdAt: record.createdAtMs,
        followUp: event.payload.isFollowUp,
      } };
      message.artifacts = [...(message.artifacts ?? []), artifact];
      starts.set(key, artifact);
    } else if (event.type !== "agent-progress") {
      const artifact = starts.get(key);
      if (artifact?.payload.kind === "agent-work") {
        artifact.payload = { ...artifact.payload, state: "done", completed: event.type === "agent-completed" ? 1 : 0, failed: event.type !== "agent-completed" };
      }
    }
  }
  return messages.map(message => ({ ...message, ...(message.replyRefs ? {
    replyRefs: message.replyRefs.map(ref => ref.kind === "agent" ? { ...ref, title: titles.get(ref.threadId) || ref.title } : ref),
  } : {}) }));
}

/** Lifecycle state of a task as the transcript's work cards last saw it. */
export type MobileAgentState = "running" | "completed" | "error";

export type MobileReplyContexts = ReplyContextProjection & {
  /** Latest known state per agent thread, for the quoted task's status glyph. */
  agentStates: ReadonlyMap<string, MobileAgentState>;
};

const agentIdsOf = (message: ChatMessage): string[] => {
  const ids: string[] = [...(message.spawnedThreadIds ?? [])];
  for (const artifact of message.artifacts ?? []) {
    if (artifact.payload.kind === "agent-work") {
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
