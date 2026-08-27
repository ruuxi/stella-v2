import path from "node:path";

import {
  readJsonStateFile,
  updateJsonStateFile,
} from "../shared/atomic-json-state.js";
import { parseThreadCheckpoint } from "../thread-runtime.js";

export type ReminderWindowStore = {
  loadThreadMessages: (
    threadKey: string,
  ) => Array<{ content: string; timestamp: number }>;
};

const STATE_FILE_SEGMENTS = ["runtime", "reminder-window-state.json"] as const;

const MAX_TRACKED_ENTRIES = 500;

type ReminderWindowStateFile = {
  version: 1;

  shown: Record<string, Record<string, number>>;
};

const statePath = (stellaDataDir: string) =>
  path.join(stellaDataDir, ...STATE_FILE_SEGMENTS);

const parseState = (raw: unknown): ReminderWindowStateFile => {
  const parsed = raw as ReminderWindowStateFile | undefined;
  if (parsed?.version === 1 && parsed.shown) return parsed;

  return { version: 1, shown: {} };
};

const readState = async (
  stellaDataDir: string,
): Promise<ReminderWindowStateFile> =>
  readJsonStateFile(statePath(stellaDataDir), parseState);

const pruneState = (state: ReminderWindowStateFile) => {
  const flat: Array<{ threadKey: string; key: string; at: number }> = [];
  for (const [threadKey, keys] of Object.entries(state.shown)) {
    for (const [key, at] of Object.entries(keys)) {
      flat.push({ threadKey, key, at });
    }
  }
  if (flat.length <= MAX_TRACKED_ENTRIES) return;
  flat.sort((left, right) => right.at - left.at);
  const kept = flat.slice(0, MAX_TRACKED_ENTRIES);
  const shown: ReminderWindowStateFile["shown"] = {};
  for (const entry of kept) {
    (shown[entry.threadKey] ??= {})[entry.key] = entry.at;
  }
  state.shown = shown;
};

export const getLastCompactionAt = (
  store: ReminderWindowStore,
  threadKey: string,
): number => {
  let messages: Array<{ content: string; timestamp: number }>;
  try {
    messages = store.loadThreadMessages(threadKey);
  } catch {
    return 0;
  }
  let latest = 0;
  for (const message of messages) {
    if (typeof message.content !== "string" || !message.content) continue;
    if (parseThreadCheckpoint(message.content) === null) continue;
    if (Number.isFinite(message.timestamp) && message.timestamp > latest) {
      latest = message.timestamp;
    }
  }
  return latest;
};

export const isReminderShownInActiveWindow = async (options: {
  stellaDataDir: string;
  store: ReminderWindowStore;
  threadKey: string;
  key: string;
}): Promise<boolean> => {
  const state = await readState(options.stellaDataDir);
  const shownAt = state.shown[options.threadKey]?.[options.key];
  if (typeof shownAt !== "number" || !Number.isFinite(shownAt)) return false;
  const lastCompactionAt = getLastCompactionAt(
    options.store,
    options.threadKey,
  );
  return shownAt > lastCompactionAt;
};

export const recordReminderShown = async (options: {
  stellaDataDir: string;
  threadKey: string;
  key: string;
  timestamp?: number;
}): Promise<void> => {
  await updateJsonStateFile({
    filePath: statePath(options.stellaDataDir),
    parse: parseState,
    update: (state) => {
      (state.shown[options.threadKey] ??= {})[options.key] =
        options.timestamp ?? Date.now();
      pruneState(state);
    },
  });
};
