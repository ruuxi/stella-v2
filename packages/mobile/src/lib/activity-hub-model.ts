import type { ActivityIndicatorEntry } from "@stella/contracts/activity-indicator";
import {
  agentWorkCardSections,
  isAgentWorkArtifact,
  isNoiseFileArtifact,
} from "./agent-artifact-consolidation";
import type { ChatArtifact, ChatMessage, MobileTask } from "../types";

/**
 * A `running` snapshot with no fresher evidence than this is treated as
 * settled.
 *
 * The phone's task list is a fold of whatever snapshots reached it — synced
 * message rows and journal records — and nothing guarantees the terminal one
 * ever arrives: the loaded window can simply start after an agent spawned and
 * end before it finished, and a computer that has since gone away reports no
 * authoritative rows to correct it. Those orphans used to read as running
 * forever, which is what put a phantom tally in the top bar and kept the
 * sidebar's rows shimmering with nothing actually in flight.
 *
 * Desktop never had the problem because its rows come straight from the
 * runtime's own lifecycle. The window matches the one the desktop projection
 * and the persisted loader already use (`AGENT_WORK_STALE_MS`), so all three
 * agree on when silence counts as finished.
 */
export const RUNNING_TASK_STALE_MS = 5 * 60_000;

/** Freshest evidence that a task was still alive. */
const lastSeenAt = (task: MobileTask): number =>
  task.updatedAt ?? task.completedAt ?? task.createdAt;

/**
 * Settle `running` tasks that have gone quiet past the stale window.
 *
 * Applied once, where the hub is published, so every surface reading it — the
 * top-bar indicator, its menu, the sidebar's rows and group summaries — agrees
 * without each having to re-derive liveness. Deliberately NOT folded into the
 * task merge itself: that merge's rules let a terminal snapshot beat a running
 * one, so settling there could stop a genuinely long agent's authoritative row
 * from winning. Here it only ever affects what the chrome displays.
 */
export const settleStaleHubTasks = (
  tasks: readonly MobileTask[],
  nowMs: number = Date.now(),
): MobileTask[] =>
  tasks.map((task) => {
    if (task.status !== "running") return task;
    // The journal itself says this agent is working. Silence in the rows this
    // device happens to hold says nothing about that, and settling it here is
    // exactly how a phone that had been closed for a while came back claiming
    // nothing was in progress while several agents were.
    if (task.authoritativeRunning) return task;
    if (nowMs - lastSeenAt(task) <= RUNNING_TASK_STALE_MS) return task;
    const { statusText: _statusText, ...rest } = task;
    return { ...rest, status: "completed" as const };
  });

const hubTaskActivityAt = (task: MobileTask): number =>
  Math.max(task.createdAt, task.updatedAt ?? 0, task.completedAt ?? 0);

const compareHubTasks = (a: MobileTask, b: MobileTask): number => {
  const activeRank = (task: MobileTask) => (task.status === "running" ? 0 : 1);
  return (
    activeRank(a) - activeRank(b) ||
    hubTaskActivityAt(b) - hubTaskActivityAt(a) ||
    b.createdAt - a.createdAt ||
    a.id.localeCompare(b.id)
  );
};

/** Active agents first, then most-recently-active within each status group. */
export const sortHubTasksByRecency = (
  tasks: readonly MobileTask[],
): MobileTask[] => [...tasks].sort(compareHubTasks);

/**
 * One top-level Activity entry: a parent agent plus every descendant subagent
 * it owns (flattened, active-first). Standalone tasks have no subagents.
 *
 * This mirrors the desktop activity workspace's `groupActivityTasks`
 * association rule (desktop-ui `event-transforms.ts`): a task whose
 * `parentAgentId` resolves to another visible task is nested under that owner
 * instead of standing on its own root row. The rule is replicated here rather
 * than imported because the desktop projection is built on its own `TaskItem`
 * model and manager-status helpers; only the pure parent→child association is
 * shared in spirit. Missing/unresolved parents fail open as standalone rows,
 * and cyclic ownership is broken so no work can disappear.
 */
export type HubTaskGroup = {
  owner: MobileTask;
  /** All descendant subagents, flattened and active-first. */
  subagents: MobileTask[];
};

/**
 * Project a flat, activity-ordered task list into top-level groups. A group is
 * active when either its owner or one of its descendants is running, matching
 * the running indicator shown on the collapsed row. Groups and descendants
 * use most-recent activity as their secondary order.
 */
export const groupActivityHubTasks = (
  orderedTasks: readonly MobileTask[],
): HubTaskGroup[] => {
  const taskById = new Map(orderedTasks.map((task) => [task.id, task]));
  const childrenByParentId = new Map<string, MobileTask[]>();
  const ownedIds = new Set<string>();
  for (const task of orderedTasks) {
    const parentId = task.parentAgentId;
    if (!parentId || parentId === task.id || !taskById.has(parentId)) continue;
    const siblings = childrenByParentId.get(parentId);
    if (siblings) siblings.push(task);
    else childrenByParentId.set(parentId, [task]);
    ownedIds.add(task.id);
  }

  // Breadth-first descendant walk, guarded against cycles so a corrupt edge
  // can never loop forever or double-count a task.
  const collectDescendants = (rootId: string): MobileTask[] => {
    const out: MobileTask[] = [];
    const seen = new Set<string>([rootId]);
    const queue = [...(childrenByParentId.get(rootId) ?? [])];
    while (queue.length > 0) {
      const task = queue.shift() as MobileTask;
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      out.push(task);
      const children = childrenByParentId.get(task.id);
      if (children) queue.push(...children);
    }
    return sortHubTasksByRecency(out);
  };

  const groups: HubTaskGroup[] = [];
  const represented = new Set<string>();
  for (const task of orderedTasks) {
    if (ownedIds.has(task.id)) continue;
    const subagents = collectDescendants(task.id);
    groups.push({ owner: task, subagents });
    represented.add(task.id);
    for (const child of subagents) represented.add(child.id);
  }

  // Cyclic ownership leaves some tasks owned-but-never-reached. Fail them open
  // as standalone top-level rows so nothing vanishes from Activity.
  for (const task of orderedTasks) {
    if (represented.has(task.id)) continue;
    groups.push({ owner: task, subagents: [] });
    represented.add(task.id);
  }
  const groupIsActive = (group: HubTaskGroup) =>
    group.owner.status === "running" ||
    group.subagents.some((task) => task.status === "running");
  const groupActivityAt = (group: HubTaskGroup) =>
    group.subagents.reduce(
      (latest, task) => Math.max(latest, hubTaskActivityAt(task)),
      hubTaskActivityAt(group.owner),
    );
  return groups.sort(
    (a, b) =>
      Number(groupIsActive(b)) - Number(groupIsActive(a)) ||
      groupActivityAt(b) - groupActivityAt(a) ||
      compareHubTasks(a.owner, b.owner),
  );
};

/**
 * The running top-level agents, as the top-bar indicator reads them out.
 * Governed by the owner, like desktop's top-level work units: an owned
 * subagent is never counted as separate work, so the count the indicator
 * reads out matches what desktop's own indicator would say.
 */
export const runningActivityIndicatorEntries = (
  tasks: readonly MobileTask[],
): ActivityIndicatorEntry[] =>
  groupActivityHubTasks(sortHubTasksByRecency(tasks))
    .filter((group) => group.owner.status === "running")
    .map((group) => ({ id: group.owner.id, title: group.owner.title.trim() }));

/** Full, newest-first artifact dataset for ownership and search. */
export const collectActivityHubArtifacts = (
  messages: readonly Pick<ChatMessage, "artifacts">[],
): ChatArtifact[] => {
  const seen = new Set<string>();
  const out: ChatArtifact[] = [];
  const push = (artifact: ChatArtifact) => {
    if (isNoiseFileArtifact(artifact) || seen.has(artifact.id)) return;
    seen.add(artifact.id);
    out.push(artifact);
  };

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const artifact of messages[index].artifacts ?? []) {
      if (isAgentWorkArtifact(artifact)) {
        for (const section of agentWorkCardSections(artifact) ?? []) {
          for (const file of section.files) push(file);
        }
        continue;
      }
      push(artifact);
    }
  }
  return out;
};