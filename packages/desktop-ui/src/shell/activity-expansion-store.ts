import { uiState } from "@/platform/ui-state";

const STORAGE_KEY = "stella.sidebar.activityExpansion";
const MAX_CONVERSATIONS = 8;

export type ActivityExpansionSnapshot = {
  seenTaskIds: readonly string[];
  taskOverrides: Readonly<Record<string, boolean>>;
};

type PersistedEntry = ActivityExpansionSnapshot & { updatedAt: number };
type PersistedMap = Record<string, PersistedEntry>;

export const EMPTY_ACTIVITY_EXPANSION: ActivityExpansionSnapshot = {
  seenTaskIds: [],
  taskOverrides: {},
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isBooleanRecord = (value: unknown): value is Record<string, boolean> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === "boolean");

const readPersisted = (): PersistedMap => {
  try {
    const raw = uiState.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const map: PersistedMap = {};
    for (const [id, entry] of Object.entries(parsed)) {
      const candidate = entry as Partial<PersistedEntry>;
      if (
        isStringArray(candidate.seenTaskIds) &&
        isBooleanRecord(candidate.taskOverrides) &&
        typeof candidate.updatedAt === "number"
      ) {
        map[id] = candidate as PersistedEntry;
      }
    }
    return map;
  } catch {
    return {};
  }
};

export const activityExpansionStore = {
  load(conversationId: string): ActivityExpansionSnapshot {
    return readPersisted()[conversationId] ?? EMPTY_ACTIVITY_EXPANSION;
  },

  save(conversationId: string, snapshot: ActivityExpansionSnapshot): void {

    const map = readPersisted();

    const latest = Math.max(0, ...Object.values(map).map((e) => e.updatedAt));
    map[conversationId] = {
      ...snapshot,
      updatedAt: Math.max(Date.now(), latest + 1),
    };
    const ids = Object.keys(map);
    if (ids.length > MAX_CONVERSATIONS) {
      ids
        .sort((a, b) => map[b].updatedAt - map[a].updatedAt)
        .slice(MAX_CONVERSATIONS)
        .forEach((id) => delete map[id]);
    }
    uiState.setItem(STORAGE_KEY, JSON.stringify(map));
  },
};
