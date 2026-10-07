import type { AgentActivityEntry } from "@stella/contracts/conversation-agent-activity";
import type { MobileTask } from "../types";

/**
 * What this device has already watched finish, kept so the journal owner's
 * running-agent snapshot can never resurrect it.
 *
 * The snapshot in a `ready` frame is folded over the WHOLE journal, which is
 * why it is seeded into the record fold: it is the only thing that can name an
 * agent whose `agent-started` row sits below the window this device holds. But
 * it is only re-sent on connect, while the retained records are trimmed to
 * `MAX_CLIENT_RECORDS` as the conversation grows. So a busy conversation walks
 * into this: the agent finishes, its terminal row settles the seeded row, and
 * then that terminal row scrolls out of the retained window — after which the
 * same stale snapshot seeds the agent as running again with nothing left to
 * settle it, and `authoritativeRunning` exempts it from the staleness rule
 * that would otherwise have quietly retired it. The count stays high until the
 * socket reconnects.
 *
 * Remembering the terminals this device actually saw closes that loop: the
 * snapshot stays a FLOOR for agents there is no local evidence about, rather
 * than an override of evidence there is. A restart is still respected — a
 * snapshot entry newer than the terminal we remember wins, which is what a
 * `send_input` follow-up on a settled thread looks like.
 */
export type SettledAgentMemory = ReadonlyMap<string, number>;

export const EMPTY_SETTLED_AGENTS: SettledAgentMemory = new Map();

/** Settled agents one conversation's memory holds before forgetting the oldest. */
const MAX_REMEMBERED = 256;

const settledAt = (task: MobileTask): number =>
  task.completedAt ?? task.updatedAt ?? task.createdAt;

/**
 * Fold the terminal rows of a task list into the memory, returning the same
 * map when nothing is new so callers can keep a stable reference.
 */
export const rememberSettledAgents = (
  memory: SettledAgentMemory,
  tasks: readonly MobileTask[],
): SettledAgentMemory => {
  let next: Map<string, number> | null = null;
  for (const task of tasks) {
    if (task.status === "running") continue;
    const at = settledAt(task);
    const known = memory.get(task.id);
    if (known !== undefined && known >= at) continue;
    next ??= new Map(memory);
    next.set(task.id, at);
  }
  if (!next) return memory;
  if (next.size > MAX_REMEMBERED) {
    const oldestFirst = [...next.entries()].sort((a, b) => a[1] - b[1]);
    for (const [agentId] of oldestFirst.slice(0, next.size - MAX_REMEMBERED)) {
      next.delete(agentId);
    }
  }
  return next;
};

/**
 * Drop snapshot entries this device has already watched finish, keeping the
 * array identity when every entry survives.
 */
export const withoutSettledAgents = (
  agents: readonly AgentActivityEntry[],
  memory: SettledAgentMemory,
): readonly AgentActivityEntry[] => {
  if (memory.size === 0 || agents.length === 0) return agents;
  const live = agents.filter((agent) => {
    const known = memory.get(agent.agentId);
    return known === undefined || agent.updatedAtMs > known;
  });
  return live.length === agents.length ? agents : live;
};
