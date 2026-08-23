import {
  agentWorkCardSections,
  isAgentWorkArtifact,
  isNoiseFileArtifact,
} from "./agent-artifact-consolidation";
import type { ChatArtifact, ChatMessage, MobileTask } from "../types";

export const ACTIVITY_PAGE_SIZE = 16;
const MAX_WINDOW_PAGES = 3;

export type ActivityWindow = {
  start: number;
  end: number;
};

export type ActivityArtifactGroups = {
  byTaskId: ReadonlyMap<string, ChatArtifact[]>;
  conversation: ChatArtifact[];
};

export const initialActivityWindow = (total: number): ActivityWindow => ({
  start: 0,
  end: Math.min(ACTIVITY_PAGE_SIZE, total),
});

export const rebaseActivityWindow = (
  window: ActivityWindow,
  total: number,
): ActivityWindow => {
  if (total <= 0) return { start: 0, end: 0 };
  const intendedSize = Math.max(1, window.end - window.start);
  if (window.start < total && window.end <= total) return window;
  const end = Math.min(total, Math.max(intendedSize, window.end));
  return {
    start: Math.max(0, end - intendedSize),
    end,
  };
};

export const loadOlderActivityWindow = (
  window: ActivityWindow,
  total: number,
): ActivityWindow => {
  if (window.end >= total) return window;
  const end = Math.min(total, window.end + ACTIVITY_PAGE_SIZE);
  const maxSize = ACTIVITY_PAGE_SIZE * MAX_WINDOW_PAGES;
  return {
    start: Math.max(window.start, end - maxSize),
    end,
  };
};

export const loadNewerActivityWindow = (
  window: ActivityWindow,
): ActivityWindow => {
  if (window.start <= 0) return window;
  const start = Math.max(0, window.start - ACTIVITY_PAGE_SIZE);
  const maxSize = ACTIVITY_PAGE_SIZE * MAX_WINDOW_PAGES;
  return {
    start,
    end: Math.min(window.end, start + maxSize),
  };
};

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

/** Stable virtualized-row identity used by LegendList's data-change anchor. */
export const activityHubTaskRowKey = (task: Pick<MobileTask, "id">): string =>
  `task:${task.id}`;

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

export type HubSubagentSummary = {
  total: number;
  running: number;
  done: number;
  error: number;
  canceled: number;
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

/** Stable virtualized-row identity for a top-level group (keyed on owner). */
export const activityHubGroupRowKey = (group: {
  owner: Pick<MobileTask, "id">;
}): string => activityHubTaskRowKey(group.owner);

/** Counts used by the collapsed "N subagents · M done" summary bar. */
export const summarizeHubSubagents = (
  subagents: readonly MobileTask[],
): HubSubagentSummary => ({
  total: subagents.length,
  running: subagents.filter((task) => task.status === "running").length,
  done: subagents.filter((task) => task.status === "completed").length,
  error: subagents.filter((task) => task.status === "error").length,
  canceled: subagents.filter((task) => task.status === "canceled").length,
});

/** Single-line summary shown on a collapsed subagent group. */
export const hubSubagentSummaryText = (summary: HubSubagentSummary): string => {
  const noun = summary.total === 1 ? "subagent" : "subagents";
  return `${summary.total} ${noun} · ${summary.done} done`;
};

/** Full, newest-first artifact dataset for ownership and search. Display
 *  pagination is applied later to activity rows, never to this source. */
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

/**
 * Attribute the activity hub's already-deduped artifact list to the task that
 * produced each file. Modern desktop bridges carry an exact agent id on each
 * agent-work file section; every remaining loose artifact on those rows is
 * orchestrator-direct by contract. Older row-scoped payloads fall back only
 * when exactly one task can own the files. Ambiguous and direct artifacts stay
 * owned by the conversation instead of becoming a global Files section.
 */
export const groupActivityArtifacts = (
  messages: readonly Pick<ChatMessage, "artifacts" | "tasks">[],
  artifacts: readonly ChatArtifact[],
): ActivityArtifactGroups => {
  const ownerByArtifactId = new Map<string, string>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const hasConsolidatedAgentWork = (message.artifacts ?? []).some(
      (artifact) =>
        isAgentWorkArtifact(artifact) && artifact.payload.agents !== undefined,
    );
    const fallbackTaskId =
      !hasConsolidatedAgentWork && message.tasks?.length === 1
        ? message.tasks[0].id
        : undefined;
    for (const artifact of message.artifacts ?? []) {
      if (isAgentWorkArtifact(artifact)) {
        for (const section of agentWorkCardSections(artifact) ?? []) {
          if (!section.agentId) continue;
          for (const file of section.files) {
            if (!ownerByArtifactId.has(file.id)) {
              ownerByArtifactId.set(file.id, section.agentId);
            }
          }
        }
        continue;
      }
      if (fallbackTaskId && !ownerByArtifactId.has(artifact.id)) {
        ownerByArtifactId.set(artifact.id, fallbackTaskId);
      }
    }
  }

  const byTaskId = new Map<string, ChatArtifact[]>();
  const conversation: ChatArtifact[] = [];
  for (const artifact of artifacts) {
    const taskId = ownerByArtifactId.get(artifact.id);
    if (!taskId) {
      conversation.push(artifact);
      continue;
    }
    const files = byTaskId.get(taskId);
    if (files) files.push(artifact);
    else byTaskId.set(taskId, [artifact]);
  }

  return { byTaskId, conversation };
};
