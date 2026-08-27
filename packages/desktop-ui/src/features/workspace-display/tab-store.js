import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";

export const OVERVIEW_ENTRY_ID = "__overview__";

export const DISPLAY_PANEL_MIN_WIDTH = 320;
export const DISPLAY_MAIN_CONTENT_MIN_WIDTH = 352;
const STORAGE_KEY_WIDTH = "stella.displayPanel.width";
const STORAGE_KEY_EXPANDED = "stella.displayPanel.expanded";
const readPersistedWidth = () => {
    if (typeof window === "undefined")
        return null;
    const raw = uiState.getItem(STORAGE_KEY_WIDTH);
    if (!raw)
        return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return null;
    return parsed;
};
const readPersistedExpanded = () => {
    if (typeof window === "undefined")
        return false;
    return uiState.getItem(STORAGE_KEY_EXPANDED) === "1";
};
const writePersistedWidthNow = (width) => {
    if (typeof window === "undefined")
        return;
    if (width == null)
        uiState.removeItem(STORAGE_KEY_WIDTH);
    else
        uiState.setItem(STORAGE_KEY_WIDTH, String(Math.round(width)));
};

let pendingPersistedWidth = null;
let persistedWidthTimer = null;
const PERSIST_WIDTH_DEBOUNCE_MS = 150;
const flushPersistedWidth = () => {
    if (persistedWidthTimer) {
        clearTimeout(persistedWidthTimer);
        persistedWidthTimer = null;
    }
    if (!pendingPersistedWidth)
        return;
    writePersistedWidthNow(pendingPersistedWidth.value);
    pendingPersistedWidth = null;
};
const schedulePersistedWidth = (width) => {
    pendingPersistedWidth = { value: width };
    if (persistedWidthTimer)
        return;
    persistedWidthTimer = setTimeout(() => {
        persistedWidthTimer = null;
        flushPersistedWidth();
    }, PERSIST_WIDTH_DEBOUNCE_MS);
};
if (typeof window !== "undefined") {

    window.addEventListener("pagehide", flushPersistedWidth);
    window.addEventListener("beforeunload", flushPersistedWidth);
}
const writePersistedExpanded = (expanded) => {
    if (typeof window === "undefined")
        return;
    if (expanded)
        uiState.setItem(STORAGE_KEY_EXPANDED, "1");
    else
        uiState.removeItem(STORAGE_KEY_EXPANDED);
};
const EMPTY_SNAPSHOT = {
    tabs: [],
    activeTabId: null,
    panelOpen: false,
    panelExpanded: readPersistedExpanded(),
    panelWidth: readPersistedWidth(),
};
let state = EMPTY_SNAPSHOT;
let tabListSnapshot = {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
};
let layoutSnapshot = {
    panelOpen: state.panelOpen,
    panelExpanded: state.panelExpanded,
    panelWidth: state.panelWidth,
};
let nextOrd = 1;
const listeners = new Set();
const tabListListeners = new Set();
const layoutListeners = new Set();

let history = [OVERVIEW_ENTRY_ID];
let historyIndex = 0;
const navListeners = new Set();
const computeNavSnapshot = () => ({
    currentEntryId: history[historyIndex] ?? OVERVIEW_ENTRY_ID,
    canGoBack: historyIndex > 0,
    canGoForward: historyIndex < history.length - 1,
});
let navSnapshot = computeNavSnapshot();
const emitNav = () => {
    navSnapshot = computeNavSnapshot();
    for (const listener of navListeners)
        listener();
};

const pushHistory = (entryId) => {
    if (history[historyIndex] === entryId)
        return;
    history = [...history.slice(0, historyIndex + 1), entryId];
    historyIndex = history.length - 1;
    emitNav();
};

const dropFromHistory = (entryId) => {
    const filtered = history.filter((id) => id !== entryId);
    const deduped = [];
    for (const id of filtered) {
        if (deduped[deduped.length - 1] !== id)
            deduped.push(id);
    }
    const next = deduped.length > 0 ? deduped : [OVERVIEW_ENTRY_ID];
    historyIndex = Math.min(historyIndex, next.length - 1);
    history = next;
    emitNav();
};
const emit = (next, options = {}) => {
    state = next;
    if (options.tabsChanged) {
        tabListSnapshot = { tabs: next.tabs, activeTabId: next.activeTabId };
        for (const listener of tabListListeners)
            listener();
    }
    if (options.layoutChanged) {
        layoutSnapshot = {
            panelOpen: next.panelOpen,
            panelExpanded: next.panelExpanded,
            panelWidth: next.panelWidth,
        };
        for (const listener of layoutListeners)
            listener();
    }

    for (const listener of listeners)
        listener();
};
const findIndex = (snap, tabId) => snap.tabs.findIndex((tab) => tab.id === tabId);

export const displayTabs = {
    subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    subscribeTabList(listener) {
        tabListListeners.add(listener);
        return () => tabListListeners.delete(listener);
    },

    subscribeLayout(listener) {
        layoutListeners.add(listener);
        return () => layoutListeners.delete(listener);
    },

    subscribeNav(listener) {
        navListeners.add(listener);
        return () => navListeners.delete(listener);
    },
    getSnapshot() {
        return state;
    },
    getTabListSnapshot() {
        return tabListSnapshot;
    },
    getLayoutSnapshot() {
        return layoutSnapshot;
    },
    getNavSnapshot() {
        return navSnapshot;
    },

    openTab(spec, opts = {}) {
        const activate = opts.activate ?? true;
        const openPanel = opts.openPanel ?? (activate ? true : state.panelOpen);
        const existingIndex = findIndex(state, spec.id);
        let nextTabs;
        if (existingIndex === -1) {
            const tab = { ...spec, ord: nextOrd++ };
            nextTabs = [...state.tabs, tab];
        }
        else {
            const previous = state.tabs[existingIndex];
            const refreshed = { ...spec, ord: previous.ord };
            nextTabs = state.tabs.map((tab, idx) => idx === existingIndex ? refreshed : tab);
        }
        const nextActiveTabId = activate
            ? spec.id
            : (state.activeTabId ?? spec.id);
        emit({
            ...state,
            tabs: nextTabs,
            activeTabId: nextActiveTabId,
            panelOpen: openPanel,
        }, {
            tabsChanged: true,
            layoutChanged: openPanel !== state.panelOpen,
        });

        if (activate)
            pushHistory(spec.id);
    },

    activateTab(tabId) {
        if (findIndex(state, tabId) === -1)
            return;
        if (state.activeTabId === tabId && state.panelOpen) {
            pushHistory(tabId);
            return;
        }
        const tabsChanged = state.activeTabId !== tabId;
        const layoutChanged = !state.panelOpen;
        emit({ ...state, activeTabId: tabId, panelOpen: true }, { tabsChanged, layoutChanged });
        pushHistory(tabId);
    },

    showOverview() {
        const layoutChanged = !state.panelOpen;
        if (layoutChanged) {
            emit({ ...state, panelOpen: true }, { layoutChanged: true });
        }
        pushHistory(OVERVIEW_ENTRY_ID);
    },

    back() {
        if (historyIndex <= 0)
            return;
        historyIndex -= 1;
        const entryId = history[historyIndex] ?? OVERVIEW_ENTRY_ID;
        if (entryId !== OVERVIEW_ENTRY_ID && findIndex(state, entryId) !== -1) {
            if (state.activeTabId !== entryId) {
                emit({ ...state, activeTabId: entryId }, { tabsChanged: true });
            }
        }
        emitNav();
    },

    forward() {
        if (historyIndex >= history.length - 1)
            return;
        historyIndex += 1;
        const entryId = history[historyIndex] ?? OVERVIEW_ENTRY_ID;
        if (entryId !== OVERVIEW_ENTRY_ID && findIndex(state, entryId) !== -1) {
            if (state.activeTabId !== entryId) {
                emit({ ...state, activeTabId: entryId }, { tabsChanged: true });
            }
        }
        emitNav();
    },

    closeTab(tabId) {
        const idx = findIndex(state, tabId);
        if (idx === -1)
            return;
        const remaining = state.tabs.filter((tab) => tab.id !== tabId);
        if (remaining.length === 0) {
            emit({ ...state, tabs: [], activeTabId: null, panelOpen: false }, { tabsChanged: true, layoutChanged: state.panelOpen });
            dropFromHistory(tabId);
            return;
        }
        let nextActive = state.activeTabId;
        if (state.activeTabId === tabId) {
            const fallback = remaining[idx - 1] ?? remaining[idx] ?? remaining[0];
            nextActive = fallback?.id ?? null;
        }
        emit({ ...state, tabs: remaining, activeTabId: nextActive }, { tabsChanged: true });
        dropFromHistory(tabId);
    },

    setPanelOpen(open) {
        if (state.panelOpen === open)
            return;
        emit({ ...state, panelOpen: open }, { layoutChanged: true });
    },
    reorderTab(tabId, targetIndex) {
        const idx = findIndex(state, tabId);
        if (idx === -1)
            return;
        const boundedTarget = Math.max(0, Math.min(targetIndex, state.tabs.length - 1));
        if (idx === boundedTarget)
            return;
        const nextTabs = [...state.tabs];
        const [tab] = nextTabs.splice(idx, 1);
        if (!tab)
            return;
        nextTabs.splice(boundedTarget, 0, tab);
        emit({ ...state, tabs: nextTabs }, { tabsChanged: true });
    },

    setPanelExpanded(expanded) {
        if (state.panelExpanded === expanded)
            return;
        writePersistedExpanded(expanded);
        emit({ ...state, panelExpanded: expanded }, { layoutChanged: true });
    },
    togglePanelExpanded() {
        this.setPanelExpanded(!state.panelExpanded);
    },

    setPanelWidth(width) {
        if (state.panelWidth === width)
            return;
        schedulePersistedWidth(width);
        emit({ ...state, panelWidth: width }, { layoutChanged: true });
    },

    flushPersistedWidth,
    reset() {
        nextOrd = 1;
        writePersistedExpanded(false);
        writePersistedWidthNow(null);
        pendingPersistedWidth = null;
        if (persistedWidthTimer) {
            clearTimeout(persistedWidthTimer);
            persistedWidthTimer = null;
        }
        history = [OVERVIEW_ENTRY_ID];
        historyIndex = 0;
        emitNav();
        emit({
            tabs: [],
            activeTabId: null,
            panelOpen: false,
            panelExpanded: false,
            panelWidth: null,
        }, { tabsChanged: true, layoutChanged: true });
    },
};

export const useDisplayTabs = () => useSyncExternalStore(displayTabs.subscribe, displayTabs.getSnapshot, displayTabs.getSnapshot);

export const useDisplayTabList = () => useSyncExternalStore(displayTabs.subscribeTabList, displayTabs.getTabListSnapshot, displayTabs.getTabListSnapshot);

const useLayoutSlice = (pick) => useSyncExternalStore(displayTabs.subscribeLayout, () => pick(displayTabs.getLayoutSnapshot()), () => pick(displayTabs.getLayoutSnapshot()));
export const useDisplayPanelOpen = () => useLayoutSlice((s) => s.panelOpen);
export const useDisplayPanelExpanded = () => useLayoutSlice((s) => s.panelExpanded);
export const useActiveDisplayTab = () => {
    const { tabs, activeTabId } = useDisplayTabList();
    if (activeTabId == null)
        return null;
    return tabs.find((tab) => tab.id === activeTabId) ?? null;
};

export const useDisplayNav = () => useSyncExternalStore(displayTabs.subscribeNav, displayTabs.getNavSnapshot, displayTabs.getNavSnapshot);
