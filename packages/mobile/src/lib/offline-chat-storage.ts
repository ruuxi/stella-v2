import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage, MobileTask } from "../types";
import type { ToolStep } from "./tool-activity";
import {
  desktopChatOutboxStorageKeys,
  waitForDesktopChatOutboxWrites,
} from "./desktop-chat-outbox";
import { parseChatArtifacts } from "./mobile-artifacts";

export type ChatThreadId = "cloud" | "computer" | "carplay" | "carplay-computer";

const MESSAGES_KEY: Record<ChatThreadId, string> = {
  cloud: "stella-mobile-offline-chat-v1",
  computer: "stella-mobile-computer-chat-v1",
  carplay: "stella-mobile-carplay-chat-v1",
  "carplay-computer": "stella-mobile-carplay-computer-chat-v1",
};
const SYNC_STATE_KEY: Record<ChatThreadId, string> = {
  cloud: "stella-mobile-chat-sync-state-v1",
  computer: "stella-mobile-computer-sync-state-v1",
  carplay: "stella-mobile-carplay-sync-state-v1",
  "carplay-computer": "stella-mobile-carplay-computer-sync-state-v1",
};
const MAX_MESSAGES = 1000;

export type ChatSyncState = {
  conversationId: string | null;
  cursor: string | null;
};

const TASK_STATUSES = new Set(["running", "completed", "error", "canceled"]);

const STORED_RUNNING_TASK_STALE_MS = 5 * 60_000;

function parseStoredToolSteps(value: unknown): ToolStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ToolStep[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.toolName !== "string" ||
      (record.status !== "running" &&
        record.status !== "completed" &&
        record.status !== "error" &&
        record.status !== "canceled")
    ) {
      return [];
    }
    const args =
      record.args && typeof record.args === "object"
        ? Object.fromEntries(
            Object.entries(record.args as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
    return [{
      id: record.id,
      toolName: record.toolName,
      status: record.status,
      ...(args && Object.keys(args).length > 0 ? { args } : {}),
      ...(typeof record.textOffset === "number" && Number.isFinite(record.textOffset)
        ? { textOffset: record.textOffset }
        : {}),
    }];
  });
}

function parseStoredTasks(value: unknown): MobileTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: MobileTask[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const status = record.status;
    if (
      !id ||
      !title ||
      typeof status !== "string" ||
      !TASK_STATUSES.has(status)
    ) {
      continue;
    }
    const statusText =
      typeof record.statusText === "string" ? record.statusText.trim() : "";
    const agentType =
      typeof record.agentType === "string" ? record.agentType.trim() : "";
    const parentAgentId =
      typeof record.parentAgentId === "string"
        ? record.parentAgentId.trim()
        : "";
    const reasoningSummaries = Array.isArray(record.reasoningSummaries)
      ? record.reasoningSummaries.filter(
          (summary): summary is string =>
            typeof summary === "string" && summary.trim().length > 0,
        )
      : [];
    const createdAt =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? record.createdAt
        : 0;
    const completedAt =
      typeof record.completedAt === "number" &&
      Number.isFinite(record.completedAt)
        ? record.completedAt
        : undefined;
    const settledStale =
      status === "running" &&
      Date.now() - createdAt > STORED_RUNNING_TASK_STALE_MS;
    tasks.push({
      id,
      title,
      ...(agentType ? { agentType } : {}),
      ...(parentAgentId ? { parentAgentId } : {}),
      status: settledStale ? "completed" : (status as MobileTask["status"]),
      ...(statusText && !settledStale ? { statusText } : {}),
      ...(reasoningSummaries.length > 0 ? { reasoningSummaries } : {}),
      createdAt,
      ...(completedAt !== undefined ? { completedAt } : {}),
    });
  }
  return tasks;
}

function parseRow(row: unknown): ChatMessage | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const o = row as Record<string, unknown>;
  if (typeof o.id !== "string") {
    return null;
  }
  if (o.role !== "user" && o.role !== "assistant") {
    return null;
  }
  if (typeof o.text !== "string") {
    return null;
  }
  const thumbnailUris = Array.isArray(o.thumbnailUris)
    ? o.thumbnailUris.filter((v): v is string => typeof v === "string")
    : [];
  const conversationId =
    typeof o.conversationId === "string" ? o.conversationId : "";
  const artifacts = parseChatArtifacts(o.artifacts, conversationId);
  const tasks = parseStoredTasks(o.tasks);
  const toolSteps = parseStoredToolSteps(o.toolSteps);
  return {
    id: o.id,
    ...(typeof o.canonicalId === "string" && o.canonicalId.trim()
      ? { canonicalId: o.canonicalId.trim() }
      : {}),

    ...(typeof o.requestId === "string" && o.requestId.trim()
      ? { requestId: o.requestId.trim() }
      : {}),
    ...(typeof o.createdAt === "number" && Number.isFinite(o.createdAt)
      ? { createdAt: o.createdAt }
      : {}),
    ...(typeof o.canonicalCreatedAt === "number" &&
    Number.isFinite(o.canonicalCreatedAt)
      ? { canonicalCreatedAt: o.canonicalCreatedAt }
      : {}),
    role: o.role,
    text: o.text,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(toolSteps.length > 0 ? { toolSteps } : {}),
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(o.hasImage === true ? { hasImage: true } : {}),
    ...(thumbnailUris.length > 0 ? { thumbnailUris } : {}),
    ...(o.cloudFallback === true ? { cloudFallback: true } : {}),

    ...(o.queued === true ? { queued: true } : {}),
    ...(o.stopped === true ? { stopped: true } : {}),
  };
}

export async function loadChatMessages(
  thread: ChatThreadId,
): Promise<ChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(MESSAGES_KEY[thread]);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: ChatMessage[] = [];
    for (const item of parsed) {

      let row: ChatMessage | null = null;
      try {
        row = parseRow(item);
      } catch {
        row = null;
      }
      if (row) {
        out.push(row);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveChatMessages(
  thread: ChatThreadId,
  messages: ChatMessage[],
): Promise<void> {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await AsyncStorage.setItem(MESSAGES_KEY[thread], JSON.stringify(trimmed));
}

const normalizeSyncState = (value: unknown): ChatSyncState => {
  if (!value || typeof value !== "object") {
    return { conversationId: null, cursor: null };
  }
  const record = value as Record<string, unknown>;
  const conversationId =
    typeof record.conversationId === "string"
      ? record.conversationId.trim()
      : "";
  const cursor =
    typeof record.cursor === "string" ? record.cursor.trim() : "";
  return {
    conversationId: conversationId || null,
    cursor: cursor || null,
  };
};

export async function loadChatSyncState(
  thread: ChatThreadId,
): Promise<ChatSyncState> {
  try {
    const raw = await AsyncStorage.getItem(SYNC_STATE_KEY[thread]);
    if (raw) {
      return normalizeSyncState(JSON.parse(raw) as unknown);
    }
    return { conversationId: null, cursor: null };
  } catch {
    return { conversationId: null, cursor: null };
  }
}

export async function saveChatSyncState(
  thread: ChatThreadId,
  state: ChatSyncState,
): Promise<void> {
  const next = normalizeSyncState(state);
  if (!next.conversationId && !next.cursor) {
    await AsyncStorage.removeItem(SYNC_STATE_KEY[thread]);
    return;
  }
  await AsyncStorage.setItem(SYNC_STATE_KEY[thread], JSON.stringify(next));
}

export async function clearAllChatStorage(): Promise<void> {
  const keys = [
    ...Object.values(MESSAGES_KEY),
    ...Object.values(SYNC_STATE_KEY),
    ...desktopChatOutboxStorageKeys(),
  ];
  try {

    await waitForDesktopChatOutboxWrites();
    await AsyncStorage.multiRemove(keys);
  } catch {

  }
}
