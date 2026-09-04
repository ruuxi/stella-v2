import type { ReplyRef } from "@stella/contracts/reply-refs";
import type { ChatMessage, ChatArtifact } from "../types";
import type { JournalRecord } from "./cloud-conversation-protocol";

export function projectMobileLifecycle(messages: ChatMessage[], records: readonly JournalRecord[], conversationId: string): ChatMessage[] {
  const titles = new Map<string, string>();
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

const key = (ref: ReplyRef) => ref.kind === "agent" ? `a:${ref.threadId}` : `m:${ref.id}`;
export function mobileReplyContexts(messages: readonly ChatMessage[]): ReadonlyMap<string, ReplyRef> {
  let context = new Set<string>();
  const result = new Map<string, ReplyRef>();
  for (const message of messages) {
    if (message.role === "user") { context = new Set([`m:${message.id}`, `m:${message.canonicalId ?? message.id}`]); continue; }
    const refs = message.replyRefs ?? [];
    const candidates = refs.some(ref => ref.kind === "agent") ? refs.filter(ref => ref.kind === "agent") : refs;
    const visible = candidates.find(ref => !context.has(key(ref)));
    if (visible) result.set(message.id, visible);
    const next = new Set(refs.map(key));
    next.add(`m:${message.id}`);
    if (message.requestId) {
      next.add(`m:${message.requestId}`);
      if (context.has(`m:${message.requestId}`)) for (const k of context) next.add(k);
    }
    for (const artifact of message.artifacts ?? []) {
      if (artifact.payload.kind === "agent-work") for (const id of artifact.payload.agentIds ?? []) next.add(`a:${id}`);
    }
    context = next;
  }
  return result;
}

export function mobileReplyLineage(messages: readonly ChatMessage[], root: ReplyRef): ChatMessage[] {
  const owns = (message: ChatMessage) => root.kind === "agent"
    ? message.artifacts?.some(a => a.payload.kind === "agent-work" && a.payload.agentIds?.includes(root.threadId))
    : message.id === root.id || message.canonicalId === root.id;
  const selected = messages.filter(m => owns(m) || m.replyRefs?.some(ref => key(ref) === key(root)));
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
