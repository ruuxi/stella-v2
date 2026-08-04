import { useEffect, useId, useSyncExternalStore } from "react";
const candidatesByGroup = new Map();
const listenersByGroup = new Map();
let nextOrder = 0;
export const selectExclusiveAnimationOwner = (candidates) => {
    let owner = null;
    for (const candidate of candidates) {
        if (!owner ||
            candidate.priority > owner.priority ||
            (candidate.priority === owner.priority && candidate.order > owner.order)) {
            owner = candidate;
        }
    }
    return owner?.id ?? null;
};
const getOwner = (group) => selectExclusiveAnimationOwner(candidatesByGroup.get(group)?.values() ?? []);
const emit = (group) => {
    for (const listener of listenersByGroup.get(group) ?? [])
        listener();
};
const register = (group, id, priority) => {
    const candidates = candidatesByGroup.get(group) ?? new Map();
    candidates.set(id, { id, order: nextOrder++, priority });
    candidatesByGroup.set(group, candidates);
    emit(group);
    return () => {
        candidates.delete(id);
        if (candidates.size === 0)
            candidatesByGroup.delete(group);
        emit(group);
    };
};
/** Elect the most recently mounted visible candidate inside a motion group. */
export const useExclusiveAnimation = (group, candidate, priority = 0) => {
    const id = useId();
    const owner = useSyncExternalStore((listener) => {
        if (!group)
            return () => { };
        const listeners = listenersByGroup.get(group) ?? new Set();
        listeners.add(listener);
        listenersByGroup.set(group, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0)
                listenersByGroup.delete(group);
        };
    }, () => (group ? getOwner(group) : id), () => id);
    useEffect(() => {
        if (!group || !candidate)
            return;
        return register(group, id, priority);
    }, [candidate, group, id, priority]);
    return candidate && (!group || owner === id);
};
