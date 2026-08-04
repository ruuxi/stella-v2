/**
 * Shared search-query state for the unified display library overview.
 *
 * Work keeps its search field mounted. This store preserves its debounced
 * query and focus requests across the always-mounted sidebar sections, while
 * section changes can clear it without prop-drilling through the shell.
 */
import { useSyncExternalStore } from "react";
let snapshot = {
    query: "",
    open: false,
    focusRequest: 0,
};
const listeners = new Set();
const emit = () => {
    for (const listener of listeners)
        listener();
};
const update = (next) => {
    snapshot = next;
    emit();
};
export const displaySearchStore = {
    subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    getQuery() {
        return snapshot.query;
    },
    getSnapshot() {
        return snapshot;
    },
    setQuery(next) {
        if (snapshot.query === next)
            return;
        update({ ...snapshot, query: next });
    },
    open() {
        update({
            ...snapshot,
            open: true,
            focusRequest: snapshot.focusRequest + 1,
        });
    },
    close() {
        if (!snapshot.open && snapshot.query === "")
            return;
        update({ ...snapshot, query: "", open: false });
    },
    clear() {
        if (snapshot.query === "")
            return;
        update({ ...snapshot, query: "" });
    },
};
export const useDisplaySearchQuery = () => useSyncExternalStore(displaySearchStore.subscribe, () => displaySearchStore.getSnapshot().query, () => displaySearchStore.getSnapshot().query);
export const useDisplaySearchOpen = () => useSyncExternalStore(displaySearchStore.subscribe, () => displaySearchStore.getSnapshot().open, () => displaySearchStore.getSnapshot().open);
export const useDisplaySearchFocusRequest = () => useSyncExternalStore(displaySearchStore.subscribe, () => displaySearchStore.getSnapshot().focusRequest, () => displaySearchStore.getSnapshot().focusRequest);
/** Case-insensitive substring match helper shared by overview sections. */
export const matchesQuery = (haystack, q) => {
    if (!q)
        return true;
    return haystack.toLowerCase().includes(q.toLowerCase());
};
