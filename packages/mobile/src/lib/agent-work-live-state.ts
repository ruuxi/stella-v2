import type { ChatArtifact, ChatMessage, MobileTask } from "../types";

/**
 * Reconcile agent-work cards with the LIVE task state behind the activity
 * pill.
 *
 * The synced `agent-work` payload's `state` is settled desktop-side at
 * derivation time, where elapsed time doubles as evidence of completion
 * (`AGENT_WORK_STALE_MS` in `local-chat-artifacts.ts`): a thread that has
 * simply been working longer than the stale window — e.g. a `send_input`
 * follow-up steering a long task — syncs as `done`, so the card reads
 * "Finished" with a check while the activity pill (fed by the desktop's
 * authoritative `runtime_agents` rows via `overlayDesktopThreadTasks`)
 * correctly counts it as running. Desktop's `BackgroundWorkCard` never treats
 * elapsed time as completion; this transform aligns the mobile card with the
 * pill's source of truth so both surfaces agree.
 *
 * Rules:
 *   - Only the LATEST card covering an agent follows that agent's live
 *     status. Earlier turns' cards for the same thread keep their synced
 *     state — they are historical anchors, mirroring desktop's superseded
 *     occurrences staying settled while the newest card carries liveness.
 *   - A card is forced back to `running` only on live evidence of running.
 *     A live terminal status never *invents* a completion here: the card's
 *     `done` flip stays owned by the bridge's `agent-completed` event and the
 *     transcript sync (a stale folded snapshot from a prior run could
 *     otherwise re-settle a just-steered card before the authoritative rows
 *     catch up).
 *   - Multi-agent aggregates recount `completed` from live statuses when
 *     every covered agent is known; any unknown agent keeps the synced
 *     payload untouched.
 */
export const applyLiveAgentWorkState = (
  messages: ChatMessage[],
  tasks: readonly MobileTask[],
): ChatMessage[] => {
  const statusById = new Map<string, MobileTask["status"]>();
  for (const task of tasks) statusById.set(task.id, task.status);
  if (statusById.size === 0) return messages;

  // Latest card covering each agent id, in transcript order (later wins).
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
  // A card superseded by a later turn's card for the same thread stays as
  // synced — only the latest occurrence tracks the live thread.
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
  // Subtitle copy mirrors the desktop-side derivation in
  // `local-chat-artifacts.ts` (`deriveAgentWorkPayload`).
  const subtitle =
    payload.total > 1
      ? `${completed} of ${payload.total} done`
      : "Working in background";
  return {
    ...artifact,
    payload: { ...payload, state: "running", completed, subtitle },
  };
};
