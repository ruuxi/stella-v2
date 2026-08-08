import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage, MobileTask } from "../types";
import {
  desktopChatOutboxStorageKeys,
  waitForDesktopChatOutboxWrites,
} from "./desktop-chat-outbox";
import { parseChatArtifacts } from "./mobile-artifacts";

/**
 * The independent chat transcripts. The cloud thread keeps the original key
 * (it was the cloud-only store before chat unification) so existing local
 * history stays put; the computer thread gets its own key and re-hydrates from
 * the desktop bridge on mount. The carplay thread is the hands-free voice loop
 * driven from CarPlay — it rides the same cloud send pipeline but keeps its own
 * short transcript so the always-mounted CarPlay bridge never races the Chat
 * tab's "cloud" store. The carplay-computer thread is that same voice loop
 * when it targets the paired desktop: it converses with the SAME canonical
 * desktop conversation as the computer thread, but keeps its own local store
 * and sync cursor so the two mounted surfaces never race each other's
 * persistence.
 */
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

/**
 * A persisted `running` snapshot older than this loads as settled, mirroring
 * the desktop projection's stale-settle (`AGENT_WORK_STALE_MS`) so a task
 * that finished while the app was closed can't shimmer the pill forever.
 */
const STORED_RUNNING_TASK_STALE_MS = 5 * 60_000;

/**
 * Round-trip the background-task snapshots riding a persisted row. Tasks feed
 * the activity pill/tray via `collectConversationTasks`; dropping them on load
 * (the pre-fix behavior) killed the pill on every app relaunch — the sync
 * cursor is already past the spawning rows, so a cursor delta only re-delivers
 * them when the agent happens to emit another lifecycle event.
 */
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
  return {
    id: o.id,
    ...(typeof o.canonicalId === "string" && o.canonicalId.trim()
      ? { canonicalId: o.canonicalId.trim() }
      : {}),
    // The turn `requestId` links a phone-sent reply to its canonical desktop
    // row (see `mergeMessagesById`). Dropping it on reload let a restart's
    // catch-up sync re-append the already-stored reply as a duplicate when the
    // row carried a `requestId` but hadn't been stamped with a `canonicalId`
    // yet (killed before the background reconcile landed).
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
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(o.hasImage === true ? { hasImage: true } : {}),
    ...(thumbnailUris.length > 0 ? { thumbnailUris } : {}),
    ...(o.cloudFallback === true ? { cloudFallback: true } : {}),
    // A queued-but-unsent bubble must reload as queued, never as a delivered
    // message. The hook re-enqueues these on hydration so a restart actually
    // sends them (see `useChatThread`).
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
      // Hydration must be corruption-tolerant per ROW: parseRow is defensive,
      // but if a row written by a different code version still manages to
      // throw, only that row is dropped — never the whole transcript, and
      // never the boot (this runs during initial mount).
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

/**
 * Wipe every thread's transcript and sync cursor. The stores are keyed
 * globally (not per account), so sign-out and account deletion must clear
 * them or the next signed-in user inherits — and re-sends as history — the
 * previous user's messages.
 */
export async function clearAllChatStorage(): Promise<void> {
  const keys = [
    ...Object.values(MESSAGES_KEY),
    ...Object.values(SYNC_STATE_KEY),
    ...desktopChatOutboxStorageKeys(),
  ];
  try {
    // Do not let an enqueue already committing in the background recreate the
    // old account's outbox after sign-out has removed its storage keys.
    await waitForDesktopChatOutboxWrites();
    await AsyncStorage.multiRemove(keys);
  } catch {
    // Best-effort: a failed wipe must not block sign-out.
  }
}
