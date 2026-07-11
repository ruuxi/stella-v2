import {
  agentWorkCardSections,
  isAgentWorkArtifact,
} from "./agent-artifact-consolidation";
import type { ChatArtifact, ChatMessage } from "../types";

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

/**
 * Attribute the activity hub's already-deduped artifact list to the task that
 * produced each file. Modern desktop bridges carry an exact agent id on each
 * agent-work file section. Older row-scoped payloads fall back to the first
 * task on their spawning message. Artifacts from the orchestrator itself stay
 * owned by the conversation instead of becoming a global Files section.
 */
export const groupActivityArtifacts = (
  messages: readonly Pick<ChatMessage, "artifacts" | "tasks">[],
  artifacts: readonly ChatArtifact[],
): ActivityArtifactGroups => {
  const ownerByArtifactId = new Map<string, string>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const fallbackTaskId = message.tasks?.[0]?.id;
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
