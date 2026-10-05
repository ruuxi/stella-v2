import type { MobileTask } from "../types";
import {
  messageText,
  type JournalMessageRecord,
  type JournalRecord,
} from "./cloud-conversation-protocol";
import { lifecycleWakeTask } from "./mobile-reply-context";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Stella's tools reach some engines under a namespaced name (Claude Code sees
 * `mcp__stella__spawn_agent`). The runtime matches on the bare name, so the
 * journal is read the same way.
 */
export const bareToolName = (name: string): string =>
  name.includes("__") ? (name.split("__").at(-1) ?? name) : name;

const WAKE_STATUS: readonly [RegExp, MobileTask["status"]][] = [
  [/^\[Agent completed\]/mu, "completed"],
  [/^\[Subagent paused\]/mu, "completed"],
  [/^\[Task failed\]/mu, "error"],
  [/^\[Task canceled\]/mu, "canceled"],
];

const wakeStatus = (text: string): MobileTask["status"] | null => {
  for (const [pattern, status] of WAKE_STATUS) {
    if (pattern.test(text)) return status;
  }
  return null;
};

const toolResultThreadId = (record: JournalMessageRecord): string | null => {
  const details = asRecord(record.payload.details);
  if (typeof details?.thread_id === "string" && details.thread_id) {
    return details.thread_id;
  }
  try {
    const parsed = asRecord(JSON.parse(messageText(record.payload)));
    return typeof parsed?.thread_id === "string" && parsed.thread_id
      ? parsed.thread_id
      : null;
  } catch {
    return null;
  }
};

type ToolCall = { name: string; description?: string; threadId?: string };

const toolCallsById = (records: readonly JournalRecord[]) => {
  const calls = new Map<string, ToolCall>();
  for (const record of records) {
    if (record.kind !== "message" || record.role !== "assistant") continue;
    const content = record.payload.content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      const block = asRecord(entry);
      if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
      if (typeof block.name !== "string") continue;
      const args = asRecord(block.arguments);
      calls.set(block.id, {
        name: bareToolName(block.name),
        ...(typeof args?.description === "string" && args.description.trim()
          ? { description: args.description.trim() }
          : {}),
        ...(typeof args?.thread_id === "string" && args.thread_id
          ? { threadId: args.thread_id }
          : {}),
      });
    }
  }
  return calls;
};

/**
 * Background tasks as the conversation journal records them, in journal
 * order. A cloud-placed turn writes `agent-lifecycle` cards; a turn the
 * computer ran is mirrored with only its `spawn_agent` / `send_input` results
 * and the hidden wake prompt (`[Agent completed]` and friends) that reported
 * the outcome. Both read into the same task rows, so the chat can tell what
 * is running without a live connection to the computer that runs it.
 */
export const collectJournalTasks = (
  records: readonly JournalRecord[],
): MobileTask[] => {
  const carded = new Set<string>();
  for (const record of records) {
    if (record.kind === "card" && record.card.type === "agent-lifecycle") {
      carded.add(record.card.event.payload.agentId);
    }
  }
  const calls = toolCallsById(records);
  const tasks = new Map<string, MobileTask>();
  const generations = new Map<string, number>();

  const start = (
    id: string,
    title: string | undefined,
    at: number,
    extra: Partial<MobileTask> = {},
  ) => {
    const existing = tasks.get(id);
    const resolvedTitle = title?.trim() || existing?.title;
    if (!resolvedTitle) return;
    tasks.set(id, {
      id,
      title: resolvedTitle,
      status: "running",
      createdAt: at,
      updatedAt: at,
      ...(existing?.agentType ? { agentType: existing.agentType } : {}),
      ...extra,
    });
  };

  const settle = (id: string, status: MobileTask["status"], at: number) => {
    const existing = tasks.get(id);
    if (!existing || existing.status !== "running") return;
    const { statusText: _statusText, ...rest } = existing;
    tasks.set(id, { ...rest, status, completedAt: at, updatedAt: at });
  };

  for (const record of records) {
    if (record.kind === "card") {
      if (record.card.type !== "agent-lifecycle") continue;
      const { event } = record.card;
      const id = event.payload.agentId;
      const generation = event.payload.attemptGeneration;
      const current = generations.get(id) ?? 0;
      if (event.type === "agent-started") {
        if (generation < current) continue;
        generations.set(id, generation);
        start(id, event.payload.description, record.createdAtMs, {
          ...(event.payload.agentType ? { agentType: event.payload.agentType } : {}),
          ...(event.payload.statusText?.trim()
            ? { statusText: event.payload.statusText.trim() }
            : {}),
        });
        continue;
      }
      if (generation !== current) continue;
      if (event.type === "agent-progress") {
        const existing = tasks.get(id);
        const statusText = event.payload.statusText.trim();
        if (existing?.status === "running" && statusText) {
          tasks.set(id, { ...existing, statusText, updatedAt: record.createdAtMs });
        }
        continue;
      }
      settle(
        id,
        event.type === "agent-completed"
          ? "completed"
          : event.type === "agent-failed"
            ? "error"
            : "canceled",
        record.createdAtMs,
      );
      continue;
    }
    if (record.kind !== "message") continue;

    if (record.role === "user" && record.hidden) {
      const text = messageText(record.payload);
      const task = lifecycleWakeTask(text);
      const status = wakeStatus(text);
      if (!task || !status || carded.has(task.threadId)) continue;
      settle(task.threadId, status, record.createdAtMs);
      continue;
    }

    if (record.role !== "toolResult" || record.payload.isError === true) continue;
    const callId =
      typeof record.payload.toolCallId === "string" ? record.payload.toolCallId : "";
    const call = calls.get(callId);
    const toolName =
      typeof record.payload.toolName === "string"
        ? bareToolName(record.payload.toolName)
        : call?.name;
    if (toolName !== "spawn_agent" && toolName !== "send_input") continue;
    const threadId = toolResultThreadId(record) ?? call?.threadId ?? null;
    if (!threadId || carded.has(threadId)) continue;
    if (toolName === "send_input") {
      if (tasks.get(threadId)?.status === "running") continue;
      start(threadId, undefined, record.createdAtMs);
      continue;
    }
    const details = asRecord(record.payload.details);
    start(
      threadId,
      call?.description ??
        (typeof details?.description === "string" ? details.description : undefined),
      record.createdAtMs,
      { agentType: "general" },
    );
  }

  return [...tasks.values()];
};
