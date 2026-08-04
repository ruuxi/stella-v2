/**
 * Module-scoped store of HTML canvases the orchestrator's `html` tool has
 * produced. Files live under `~/.stella/outputs/html/` and a small index in
 * the shared UI state store keeps them listed across renderer and desktop
 * restarts; every mutation republishes the list into the Files index, which
 * is what the sidebar actually renders.
 */
import { setFileEntries, } from "@/features/workspace-display/files-index";
import { uiState } from "@/platform/ui-state";
/** Display-tab id for a canvas, so one file is one Files entry. */
export const canvasDisplayTabId = (filePath) => `canvas:${filePath}`;
const items = [];
const itemsByPath = new Map();
const STORAGE_KEY = "stella-display-canvas-html-items";
const REMOVED_KEY = "stella-display-canvas-html-removed";
const MAX_ITEMS = 200;
// Stable snapshot for `useSyncExternalStore`; refreshed only on mutation.
let snapshot = [];
const toFileEntry = (item) => ({
    source: "canvas",
    id: canvasDisplayTabId(item.filePath),
    kind: "canvas",
    title: item.title,
    filePath: item.filePath,
    createdAt: item.createdAt,
    payload: {
        kind: "canvas-html",
        filePath: item.filePath,
        title: item.title,
        createdAt: item.createdAt,
        ...(item.slug ? { slug: item.slug } : {}),
    },
});
const refreshSnapshot = () => {
    snapshot = items.slice();
    setFileEntries("canvas", items.map(toFileEntry));
};
const readJsonArray = (key) => {
    try {
        const parsed = JSON.parse(uiState.getItem(key) || "[]");
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
};
const writeJsonArray = (key, value) => {
    uiState.setItem(key, JSON.stringify(value));
};
const isPersistedItem = (entry) => {
    if (!entry || typeof entry !== "object")
        return false;
    const record = entry;
    return (typeof record.id === "string" &&
        typeof record.filePath === "string" &&
        typeof record.title === "string" &&
        typeof record.createdAt === "number");
};
const readPersistedItems = () => readJsonArray(STORAGE_KEY).filter(isPersistedItem).slice(-MAX_ITEMS);
const persistItems = () => writeJsonArray(STORAGE_KEY, items.slice(-MAX_ITEMS));
const removedPaths = new Set(readJsonArray(REMOVED_KEY).filter((path) => typeof path === "string"));
const persistRemovedPaths = () => writeJsonArray(REMOVED_KEY, Array.from(removedPaths));
const emit = () => {
    refreshSnapshot();
    persistItems();
};
const seedItem = (item) => {
    if (removedPaths.has(item.filePath))
        return;
    if (itemsByPath.has(item.filePath))
        return;
    items.push(item);
    itemsByPath.set(item.filePath, item);
};
const titleFromPayload = (payload) => {
    if (payload.title && payload.title.trim().length > 0)
        return payload.title;
    return payload.filePath.split(/[\\/]/).pop() ?? "Canvas";
};
/** Add or refresh a canvas item; returns the up-to-date snapshot. */
export const addCanvasHtmlItem = (payload) => {
    removedPaths.delete(payload.filePath);
    persistRemovedPaths();
    const next = {
        id: payload.filePath,
        filePath: payload.filePath,
        title: titleFromPayload(payload),
        createdAt: payload.createdAt,
        ...(payload.slug ? { slug: payload.slug } : {}),
    };
    const existing = itemsByPath.get(payload.filePath);
    if (existing) {
        // Mutate in-place so the entry keeps its identity and we still bump
        // createdAt (used as the iframe refresh key).
        existing.title = next.title;
        existing.createdAt = next.createdAt;
        if (next.slug)
            existing.slug = next.slug;
    }
    else {
        items.push(next);
        itemsByPath.set(payload.filePath, next);
    }
    emit();
    return snapshot;
};
export const removeCanvasHtmlItem = (filePath) => {
    const idx = items.findIndex((item) => item.filePath === filePath);
    if (idx === -1)
        return snapshot;
    items.splice(idx, 1);
    itemsByPath.delete(filePath);
    removedPaths.add(filePath);
    persistRemovedPaths();
    emit();
    return snapshot;
};
let historyLoadStarted = false;
export const loadCanvasHtmlHistory = async () => {
    if (historyLoadStarted)
        return;
    historyLoadStarted = true;
    const listCanvasHtml = window.electronAPI?.display?.listCanvasHtml;
    if (typeof listCanvasHtml !== "function")
        return;
    try {
        const discovered = await listCanvasHtml();
        let changed = false;
        for (const entry of discovered) {
            if (itemsByPath.has(entry.filePath))
                continue;
            seedItem({
                id: entry.filePath,
                filePath: entry.filePath,
                title: entry.title,
                slug: entry.slug,
                createdAt: entry.createdAt,
            });
            changed = true;
        }
        if (changed)
            emit();
    }
    catch {
        // Keep the list usable even if filesystem enumeration is unavailable.
    }
};
for (const item of readPersistedItems()) {
    seedItem(item);
}
refreshSnapshot();
