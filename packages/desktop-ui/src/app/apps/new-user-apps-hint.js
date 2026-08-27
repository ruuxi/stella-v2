import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
import { getSnapshot as getUserAppsSnapshot, subscribe as subscribeToUserApps, } from "./user-apps-registry";

const STORAGE_KEY = "stella:new-user-apps-seen";
const CHANGE_EVENT = "stella:new-user-apps-seen-changed";
const EMPTY_STATE = { initialized: false, seen: {} };
const safeRead = () => {
    if (typeof window === "undefined")
        return EMPTY_STATE;
    try {
        const raw = uiState.getItem(STORAGE_KEY);
        if (!raw)
            return EMPTY_STATE;
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null)
            return EMPTY_STATE;
        const seen = parsed.seen && typeof parsed.seen === "object"
            ? Object.fromEntries(Object.entries(parsed.seen).filter(([, value]) => value === true))
            : {};
        return {
            initialized: parsed.initialized === true,
            seen: seen,
        };
    }
    catch {
        return EMPTY_STATE;
    }
};
const safeWrite = (state) => {
    if (typeof window === "undefined")
        return;
    uiState.setItem(STORAGE_KEY, JSON.stringify(state));
};
const subscribers = new Set();
let listenersAttached = false;
let unsubscribeFromRegistry = null;
const handleStorageEvent = (event) => {
    if (event.storageArea !== localStorage)
        return;
    if (event.key !== STORAGE_KEY)
        return;
    for (const notify of subscribers)
        notify();
};
const handleCustomEvent = () => {
    for (const notify of subscribers)
        notify();
};
const handleRegistryChange = () => {

    for (const notify of subscribers)
        notify();
};
const attachListeners = () => {
    if (listenersAttached || typeof window === "undefined")
        return;
    listenersAttached = true;
    window.addEventListener("storage", handleStorageEvent);
    window.addEventListener(CHANGE_EVENT, handleCustomEvent);
    unsubscribeFromRegistry = subscribeToUserApps(handleRegistryChange);
};
const detachListeners = () => {
    if (!listenersAttached || typeof window === "undefined")
        return;
    if (subscribers.size > 0)
        return;
    listenersAttached = false;
    window.removeEventListener("storage", handleStorageEvent);
    window.removeEventListener(CHANGE_EVENT, handleCustomEvent);
    unsubscribeFromRegistry?.();
    unsubscribeFromRegistry = null;
};
const subscribe = (notify) => {
    subscribers.add(notify);
    attachListeners();
    return () => {
        subscribers.delete(notify);
        detachListeners();
    };
};
const notifyAll = () => {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(CHANGE_EVENT));
    }
    for (const notify of subscribers)
        notify();
};
const seedIfNeeded = (state) => {
    if (state.initialized)
        return state;
    const registry = getUserAppsSnapshot();
    if (registry.phase !== "ready")
        return state;
    const seen = {};
    for (const app of registry.apps) {
        seen[app.slug] = true;
    }
    const next = { initialized: true, seen };
    safeWrite(next);
    return next;
};

export const markAllUserAppsSeen = () => {
    const current = safeRead();
    const registry = getUserAppsSnapshot();
    if (registry.phase !== "ready")
        return;
    const nextSeen = { ...current.seen };
    let changed = !current.initialized;
    for (const app of registry.apps) {
        if (!nextSeen[app.slug]) {
            nextSeen[app.slug] = true;
            changed = true;
        }
    }
    if (!changed)
        return;
    safeWrite({ initialized: true, seen: nextSeen });
    notifyAll();
};

export const clearNewUserAppsHint = () => {
    safeWrite(EMPTY_STATE);
    notifyAll();
};
const getHintSnapshot = () => {
    const state = seedIfNeeded(safeRead());
    const registry = getUserAppsSnapshot();
    if (registry.phase !== "ready")
        return false;
    for (const app of registry.apps) {
        if (!state.seen[app.slug])
            return true;
    }
    return false;
};
const getServerSnapshot = () => false;

export function useNewUserAppsHint() {
    const active = useSyncExternalStore(subscribe, getHintSnapshot, getServerSnapshot);
    return { active, dismiss: markAllUserAppsSeen };
}
