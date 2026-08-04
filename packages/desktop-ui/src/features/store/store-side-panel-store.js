/**
 * Side-panel selection state.
 *
 * The list renders the durable feature snapshot (newest roster features)
 * first, with older roster entries paged in behind the "Show older"
 * affordance. Multi-select state lives here so the user's picks survive
 * remounts.
 */
import { useSyncExternalStore } from "react";
const OLDER_PAGE_SIZE = 20;
const EMPTY = {
    snapshot: null,
    snapshotLoading: true,
    selectedFeatureKeys: new Set(),
    olderEntries: [],
    rosterTotal: null,
    olderLoading: false,
};
/** Selection identity for a snapshot item or roster entry. */
export const featureKeyOf = (item) => item.featureId ?? item.name;
let state = EMPTY;
const listeners = new Set();
const emit = (next) => {
    state = next;
    for (const listener of listeners)
        listener();
};
const toggle = (prev, value) => {
    const next = new Set(prev);
    if (next.has(value))
        next.delete(value);
    else
        next.add(value);
    return next;
};
export const storeSidePanelStore = {
    subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    getSnapshot() {
        return state;
    },
    setSnapshot(snapshot) {
        emit({ ...state, snapshot, snapshotLoading: false });
    },
    setSnapshotLoading(loading) {
        if (state.snapshotLoading === loading)
            return;
        emit({ ...state, snapshotLoading: loading });
    },
    setRosterTotal(total) {
        if (state.rosterTotal === total)
            return;
        emit({ ...state, rosterTotal: total });
    },
    setOlderLoading(loading) {
        if (state.olderLoading === loading)
            return;
        emit({ ...state, olderLoading: loading });
    },
    appendOlderEntries(entries, total) {
        const shown = new Set([
            ...(state.snapshot?.items ?? []).map(featureKeyOf),
            ...state.olderEntries.map(featureKeyOf),
        ]);
        const fresh = entries.filter((entry) => !shown.has(featureKeyOf(entry)));
        emit({
            ...state,
            olderEntries: [...state.olderEntries, ...fresh],
            rosterTotal: total,
            olderLoading: false,
        });
    },
    toggleFeature(key) {
        emit({
            ...state,
            selectedFeatureKeys: toggle(state.selectedFeatureKeys, key),
        });
    },
    clearSelections() {
        if (state.selectedFeatureKeys.size === 0) {
            return;
        }
        emit({
            ...state,
            selectedFeatureKeys: new Set(),
        });
    },
    reset() {
        emit(EMPTY);
    },
};
export const useStoreSidePanelState = () => useSyncExternalStore(storeSidePanelStore.subscribe, storeSidePanelStore.getSnapshot, storeSidePanelStore.getSnapshot);
export const refreshFeatureSnapshot = async () => {
    const api = window.electronAPI?.store;
    if (!api?.readFeatureSnapshot) {
        storeSidePanelStore.setSnapshotLoading(false);
        return;
    }
    storeSidePanelStore.setSnapshotLoading(true);
    try {
        const snapshot = await api.readFeatureSnapshot();
        storeSidePanelStore.setSnapshot(snapshot);
    }
    catch {
        storeSidePanelStore.setSnapshotLoading(false);
    }
    // Probe the roster size so the list knows whether older features exist
    // beyond the snapshot window. Best-effort: without it the "Show older"
    // affordance simply stays hidden.
    if (!api.listFeatureRoster)
        return;
    try {
        const page = await api.listFeatureRoster({ limit: 1 });
        storeSidePanelStore.setRosterTotal(page.total);
    }
    catch {
        // Ignore — pagination is unavailable, the snapshot still renders.
    }
};
export const loadOlderFeatureEntries = async () => {
    const api = window.electronAPI?.store;
    if (!api?.listFeatureRoster)
        return;
    const current = storeSidePanelStore.getSnapshot();
    if (current.olderLoading)
        return;
    const offset = (current.snapshot?.items.length ?? 0) + current.olderEntries.length;
    storeSidePanelStore.setOlderLoading(true);
    try {
        const page = await api.listFeatureRoster({
            limit: OLDER_PAGE_SIZE,
            offset,
        });
        storeSidePanelStore.appendOlderEntries(page.entries, page.total);
    }
    catch {
        storeSidePanelStore.setOlderLoading(false);
    }
};
