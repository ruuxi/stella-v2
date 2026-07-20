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

/** Strict spawn-recency ordering for the hub. Status and completion time do
 *  not affect rank, so finishing a task cannot move its existing row. */
export const sortHubTasksByRecency = (
  tasks: readonly MobileTask[],
): MobileTask[] =>
  [...tasks].sort(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );

/** Stable virtualized-row identity used by LegendList's data-change anchor. */
export const activityHubTaskRowKey = (task: Pick<MobileTask, "id">): string =>
  `task:${task.id}`;

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
