import { useEffect, useMemo, useState } from "react";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import type { ChatArtifact, ChatMessage } from "../types";
import { getBackendClient } from "./backend";

const GENERIC_TITLE = "Task";

const untitled = (title: string | undefined, threadId: string): boolean => {
  const value = title?.trim();
  return !value || value === threadId || value === GENERIC_TITLE;
};

const unresolvedThreadIds = (messages: readonly ChatMessage[]): string[] => {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const ref of message.replyRefs ?? []) {
      if (ref.kind === "agent" && untitled(ref.title, ref.threadId)) ids.add(ref.threadId);
    }
    for (const artifact of message.artifacts ?? []) {
      const payload = artifact.payload;
      if (payload.kind !== "agent-work") continue;
      for (const agent of payload.agents ?? []) {
        if (agent.agentId && untitled(agent.title, agent.agentId)) ids.add(agent.agentId);
      }
      const only = payload.agentIds?.length === 1 ? payload.agentIds[0] : undefined;
      if (only && untitled(payload.title, only)) ids.add(only);
    }
  }
  return [...ids].sort();
};

const titledRef = (ref: ReplyRef, titles: ReadonlyMap<string, string>): ReplyRef => {
  if (ref.kind !== "agent" || !untitled(ref.title, ref.threadId)) return ref;
  const title = titles.get(ref.threadId);
  return title ? { ...ref, title } : ref;
};

const titledArtifact = (
  artifact: ChatArtifact,
  titles: ReadonlyMap<string, string>,
): ChatArtifact => {
  const payload = artifact.payload;
  if (payload.kind !== "agent-work") return artifact;
  let changed = false;
  const agents = payload.agents?.map((agent) => {
    const title = agent.agentId && untitled(agent.title, agent.agentId)
      ? titles.get(agent.agentId)
      : undefined;
    if (!title) return agent;
    changed = true;
    return { ...agent, title };
  });
  const only = payload.agentIds?.length === 1 ? payload.agentIds[0] : undefined;
  const cardTitle = only && untitled(payload.title, only) ? titles.get(only) : undefined;
  if (cardTitle) changed = true;
  if (!changed) return artifact;
  return {
    ...artifact,
    payload: {
      ...payload,
      ...(agents ? { agents } : {}),
      ...(cardTitle ? { title: cardTitle } : {}),
    },
  };
};

const titledMessage = (
  message: ChatMessage,
  titles: ReadonlyMap<string, string>,
): ChatMessage => {
  const replyRefs = message.replyRefs?.map((ref) => titledRef(ref, titles));
  const artifacts = message.artifacts?.map((artifact) => titledArtifact(artifact, titles));
  const refsChanged = replyRefs?.some((ref, index) => ref !== message.replyRefs![index]) ?? false;
  const artifactsChanged =
    artifacts?.some((artifact, index) => artifact !== message.artifacts![index]) ?? false;
  if (!refsChanged && !artifactsChanged) return message;
  return {
    ...message,
    ...(refsChanged ? { replyRefs } : {}),
    ...(artifactsChanged ? { artifacts } : {}),
  };
};

export function useAgentReplyTitles(
  conversationId: string | null,
  messages: ChatMessage[],
): ChatMessage[] {
  const key = useMemo(() => unresolvedThreadIds(messages).join("\n"), [messages]);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    setTitles(new Map());
  }, [conversationId]);
  useEffect(() => {
    if (!conversationId || !key) return;
    let client: ReturnType<typeof getBackendClient>;
    try {
      client = getBackendClient();
    } catch {
      return;
    }
    const stops = key.split("\n").map((threadId) =>
      client.watch(
        "agentThreads.get",
        { conversationId, threadId },
        (thread) => {
          const title = thread?.description?.trim();
          if (!title || untitled(title, threadId)) return;
          setTitles((current) =>
            current.get(threadId) === title ? current : new Map(current).set(threadId, title),
          );
        },
        () => {},
      ),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [conversationId, key]);
  return useMemo(
    () => (titles.size === 0 ? messages : messages.map((message) => titledMessage(message, titles))),
    [messages, titles],
  );
}
