import type { ChatArtifact, ChatMessage, MobileTask } from "../types";

export const applyLiveAgentWorkState = (
  messages: ChatMessage[],
  tasks: readonly MobileTask[],
): ChatMessage[] => {
  const statusById = new Map<string, MobileTask["status"]>();
  for (const task of tasks) statusById.set(task.id, task.status);
  if (statusById.size === 0) return messages;

  const ownerByAgentId = new Map<string, ChatArtifact>();
  for (const message of messages) {
    for (const artifact of message.artifacts ?? []) {
      for (const id of agentIdsOf(artifact)) ownerByAgentId.set(id, artifact);
    }
  }
  if (ownerByAgentId.size === 0) return messages;

  let changedAny = false;
  const next = messages.map((message) => {
    const artifacts = message.artifacts;
    if (!artifacts?.length) return message;
    let changed = false;
    const nextArtifacts = artifacts.map((artifact) => {
      const reconciled = reconcileArtifact(artifact, ownerByAgentId, statusById);
      if (reconciled !== artifact) changed = true;
      return reconciled;
    });
    if (!changed) return message;
    changedAny = true;
    return { ...message, artifacts: nextArtifacts };
  });
  return changedAny ? next : messages;
};

const agentIdsOf = (artifact: ChatArtifact): string[] => {
  if (artifact.payload.kind !== "agent-work") return [];
  const explicit = artifact.payload.agentIds
    ?.map((value) => value.trim())
    .filter(Boolean);
  if (explicit?.length) return explicit;
  if (!artifact.id.startsWith("agent-work:")) return [];
  return artifact.id
    .slice("agent-work:".length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
};

const reconcileArtifact = (
  artifact: ChatArtifact,
  ownerByAgentId: ReadonlyMap<string, ChatArtifact>,
  statusById: ReadonlyMap<string, MobileTask["status"]>,
): ChatArtifact => {
  if (artifact.payload.kind !== "agent-work") return artifact;
  const ids = agentIdsOf(artifact);
  if (ids.length === 0) return artifact;

  if (!ids.some((id) => ownerByAgentId.get(id) === artifact)) return artifact;
  const statuses = ids.map((id) => statusById.get(id));
  if (statuses.some((status) => status === undefined)) return artifact;
  const runningCount = statuses.filter((s) => s === "running").length;
  if (runningCount === 0) return artifact;

  const payload = artifact.payload;
  const completed = ids.length - runningCount;
  if (payload.state === "running" && payload.completed === completed) {
    return artifact;
  }

  const subtitle =
    payload.total > 1
      ? `${completed} of ${payload.total} done`
      : "Working in background";
  return {
    ...artifact,

    payload: { ...payload, state: "running", completed, subtitle, failed: undefined },
  };
};
