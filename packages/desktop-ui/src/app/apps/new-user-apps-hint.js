import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
import { getSnapshot as getUserAppsSnapshot, subscribe as subscribeToUserApps, } from "./user-apps-registry";
/**
 * Tiny "new app" marker on the Apps top-bar nav item. Mirrors the
 * post-onboarding hint shape but the trigger is dynamic: any user app
 * slug the user hasn't seen yet keeps the dot lit until they open the
 * Apps library.
 *
 * Storage shape (single shared-UI-state key):
 *   {
 *     initialized: boolean,           // false until the first seed
 *     seen: { [slug]: true }          // slugs the user has acknowledged
 *   }
 *
 * On the very first launch with this feature shipped, the seen set is
 * seeded from the current registry — that way existing apps don't all
 * pop a dot retroactively. After that, any new project in `~/.stella/workspace/apps`
 * whose slug isn't in `seen` lights the nav dot until the library is opened.
 */
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
    // A new app file appeared (or one was removed). The dot is derived
    // from the registry diff against the seen set, so just notify.
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
/**
 * Marks every currently-registered user app as seen. Called when a
 * library list is actually on screen.
 */
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
/**
 * Test/reset helper — drops the entire seen set so the next library
 * visit re-seeds. Not currently surfaced in the UI.
 */
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
/**
 * Subscribe to the "you have a new user app" hint dot for the Apps
 * top-bar entry. The first ready runtime registry snapshot seeds the seen set,
 * so the initial async load never makes every existing app look newly added.
 * Returns true while at least one user app exists that
 * the user hasn't acknowledged.
 */
export function useNewUserAppsHint() {
    const active = useSyncExternalStore(subscribe, getHintSnapshot, getServerSnapshot);
    return { active, dismiss: markAllUserAppsSeen };
}
