import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
const MATERIALIZED_KEY = "stella-media-materialized-jobs";
const MATERIALIZED_PAYLOADS_KEY = "stella-media-materialized-payloads";
const FAILED_NOTIFIED_KEY = "stella-media-failed-notified-jobs";
const MATERIALIZED_CAP = 1000;
const loadFromStorage = (key = MATERIALIZED_KEY) => {
    try {
        const raw = uiState.getItem(key);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        const ids = Array.isArray(parsed) ? parsed : parsed.jobIds;
        return ids ?? [];
    }
    catch {
        return [];
    }
};
// Enforce MATERIALIZED_CAP in memory (not just on persist). Maps/Sets keep
// insertion order, so deleting the first key evicts the oldest entry, keeping
// the live collection bounded mid-session without changing what gets persisted.
export const capInMemory = (collection) => {
    while (collection.size > MATERIALIZED_CAP) {
        const oldest = collection.keys().next().value;
        if (oldest === undefined)
            break;
        collection.delete(oldest);
    }
};
const persistToStorage = (ids, key = MATERIALIZED_KEY) => {
    const trimmed = Array.from(ids).slice(-MATERIALIZED_CAP);
    uiState.setItem(key, JSON.stringify(trimmed));
};
const loadPayloadsFromStorage = () => {
    const map = new Map();
    try {
        const raw = uiState.getItem(MATERIALIZED_PAYLOADS_KEY);
        if (!raw)
            return map;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return map;
        for (const entry of parsed) {
            if (!entry || typeof entry !== "object")
                continue;
            const record = entry;
            if (typeof record.jobId !== "string")
                continue;
            const payload = record.payload;
            if (!payload || typeof payload !== "object")
                continue;
            if (payload.kind !== "media")
                continue;
            map.set(record.jobId, payload);
        }
    }
    catch {
        return new Map();
    }
    return map;
};
const persistPayloadsToStorage = (payloads) => {
    const entries = Array.from(payloads.entries()).slice(-MATERIALIZED_CAP);
    uiState.setItem(MATERIALIZED_PAYLOADS_KEY, JSON.stringify(entries.map(([jobId, payload]) => ({
        jobId,
        payload,
    }))));
};
// Module-scoped, mutated through `markMediaJobMaterialized` and the
// materializer hook. Sharing the same Set across both means no race window
// where one writer's mark is invisible to the other.
export const materializedJobs = new Set(loadFromStorage());
export const failedNotifiedJobs = new Set(loadFromStorage(FAILED_NOTIFIED_KEY));
const materializedPayloadsByJobId = loadPayloadsFromStorage();
const EMPTY_MATERIALIZED_PAYLOAD_SNAPSHOT = new Map();
let materializedPayloadSnapshot = new Map(materializedPayloadsByJobId);
const materializedPayloadListeners = new Set();
export const persistMaterializedJobs = () => {
    persistToStorage(materializedJobs);
};
export const persistFailedNotifiedJobs = () => {
    persistToStorage(failedNotifiedJobs, FAILED_NOTIFIED_KEY);
};
export const publishMaterializedMediaPayload = (payload) => {
    if (payload.kind === "media" && payload.jobId) {
        const existing = materializedPayloadsByJobId.get(payload.jobId);
        // Transcript replay and the live completion subscription can construct
        // slightly different payloads for the same durable job. Job identity,
        // rather than JSON equality, is the deduplication boundary.
        if (existing)
            return false;
        materializedPayloadsByJobId.set(payload.jobId, payload);
        // Bound the in-memory payload map, matching the persist-time cap.
        capInMemory(materializedPayloadsByJobId);
        persistPayloadsToStorage(materializedPayloadsByJobId);
        // useSyncExternalStore compares snapshots by identity. Publishing a fresh
        // immutable snapshot is what makes React observe the Map mutation.
        materializedPayloadSnapshot = new Map(materializedPayloadsByJobId);
    }
    for (const listener of materializedPayloadListeners)
        listener();
    return true;
};
export const useMaterializedMediaPayload = (jobId) => useSyncExternalStore((listener) => {
    materializedPayloadListeners.add(listener);
    return () => materializedPayloadListeners.delete(listener);
}, () => (jobId ? (materializedPayloadsByJobId.get(jobId) ?? null) : null), () => null);
export const useMaterializedMediaPayloadSnapshot = () => useSyncExternalStore((listener) => {
    materializedPayloadListeners.add(listener);
    return () => materializedPayloadListeners.delete(listener);
}, () => materializedPayloadSnapshot, () => EMPTY_MATERIALIZED_PAYLOAD_SNAPSHOT);
/**
 * Mark a jobId as already-handled so the materializer skips it. Use this
 * from any UI that materializes its own jobs (e.g. MediaStudio) so we don't
 * double-download or pop the workspace panel over the user's active surface.
 */
export const markMediaJobMaterialized = (jobId) => {
    if (materializedJobs.has(jobId))
        return;
    materializedJobs.add(jobId);
    // Bound the in-memory set, matching the persist-time cap.
    capInMemory(materializedJobs);
    persistMaterializedJobs();
};
