/**
 * Persisted expansion state for the Activity rows, keyed by conversation id.
 * Two pieces per conversation, matching the defaults in `WorkspaceSections`:
 *
 *   - `seenTaskIds` — the "seen running this session" set that keeps a
 *     finished standalone agent's row expanded (files visible). Compact
 *     Manager rows are collapsed by default and use task overrides only.
 *   - `taskOverrides` — explicit user toggles, which win
 *     over the status default; persisted so a row the user deliberately
 *     collapsed doesn't spring back open after a relaunch.
 *
 * Entries are LRU-capped by conversation so the shared ui-state file can't
 * grow unboundedly; within a conversation the component already prunes ids
 * to tasks still present in the activity window before saving.
 */
import { uiState } from "@/platform/ui-state";
const STORAGE_KEY = "stella.sidebar.activityExpansion";
const MAX_CONVERSATIONS = 8;
export const EMPTY_ACTIVITY_EXPANSION = {
    seenTaskIds: [],
    taskOverrides: {},
};
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isBooleanRecord = (value) => typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "boolean");
const readPersisted = () => {
    try {
        const raw = uiState.getItem(STORAGE_KEY);
        if (!raw)
            return {};
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return {};
        const map = {};
        for (const [id, entry] of Object.entries(parsed)) {
            const candidate = entry;
            if (isStringArray(candidate.seenTaskIds) &&
                isBooleanRecord(candidate.taskOverrides) &&
                typeof candidate.updatedAt === "number") {
                map[id] = candidate;
            }
        }
        return map;
    }
    catch {
        return {};
    }
};
export const activityExpansionStore = {
    load(conversationId) {
        return readPersisted()[conversationId] ?? EMPTY_ACTIVITY_EXPANSION;
    },
    save(conversationId, snapshot) {
        // No window guard: `uiState` degrades to an in-memory map in windowless
        // environments, which is exactly what unit tests want.
        const map = readPersisted();
        // Monotonic stamp: same-millisecond saves would otherwise tie and make
        // LRU eviction order arbitrary.
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
