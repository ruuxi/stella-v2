import { useEffect, useMemo, useState } from "react";
import { useOptionalUiState } from "@/context/ui-state";
const isDisplayFileApiAvailable = () => typeof window !== "undefined" &&
    typeof window.electronAPI?.display?.readFile === "function";
const readDisplayFileRaw = async (filePath, unavailableMessage, conversationId, maxBytes) => {
    if (!isDisplayFileApiAvailable()) {
        throw new Error(unavailableMessage ?? "File preview requires the Electron host runtime.");
    }
    return await window.electronAPI.display.readFile(filePath, {
        conversationId,
        maxBytes,
    });
};
const cache = new Map();
const CACHE_GRACE_MS = 750;
/**
 * Cache key for a display-file read. A `version` token (e.g. the artifact's
 * `createdAt`/mtime) is folded in so that re-reading the SAME path after it was
 * overwritten in place — the canvas `html` tool rewrites `<slug>.html` on every
 * iteration — misses the previously-resolved entry and re-reads fresh bytes
 * from disk instead of serving the stale cached content.
 *
 * `maxBytes` is part of the key so a spreadsheet preview's 2MB prefix
 * never collides with a full-file PDF/canvas read of the same path.
 */
const displayFileCacheKey = (filePath, conversationId, version, maxBytes) => `${conversationId ?? ""}\0${filePath}\0${version ?? ""}\0${maxBytes ?? ""}`;
const blobFromBytes = (entry) => {
    if (entry.blob)
        return entry.blob;
    const resolved = entry.resolved;
    if (!resolved || resolved.missing)
        return null;
    // Allocate a fresh `ArrayBuffer` for the Blob so it owns memory
    // independent of any other view derived from `resolved.bytes`.
    const buffer = new ArrayBuffer(resolved.bytes.byteLength);
    new Uint8Array(buffer).set(resolved.bytes);
    const blob = new Blob([buffer], {
        type: resolved.mimeType || "application/octet-stream",
    });
    entry.blob = blob;
    return blob;
};
const objectUrlFor = (entry) => {
    if (entry.url)
        return entry.url;
    const blob = blobFromBytes(entry);
    if (!blob)
        return null;
    entry.url = URL.createObjectURL(blob);
    return entry.url;
};
const finalizeEvict = (filePath, entry) => {
    if (entry.url) {
        URL.revokeObjectURL(entry.url);
        entry.url = null;
    }
    entry.blob = null;
    // Only drop the map slot if it still points at this entry — a retry may
    // have replaced it (e.g. after a rejected/missing read) while stale
    // consumers of the old entry were still winding down their refs.
    if (cache.get(filePath) === entry)
        cache.delete(filePath);
};
const acquire = (filePath, unavailableMessage, conversationId, version, maxBytes) => {
    const cacheKey = displayFileCacheKey(filePath, conversationId, version, maxBytes);
    let entry = cache.get(cacheKey);
    if (!entry) {
        const promise = readDisplayFileRaw(filePath, unavailableMessage, conversationId, maxBytes);
        entry = {
            promise,
            resolved: null,
            blob: null,
            url: null,
            refCount: 0,
            evictionTimer: null,
        };
        cache.set(cacheKey, entry);
        void promise
            .then((result) => {
            // Guard against the entry having been evicted while the IPC was
            // in flight (no consumers ever subscribed).
            if (cache.get(cacheKey) !== entry)
                return;
            if (result.missing) {
                // A missing file may appear on disk moments later, so don't cache
                // the negative result. Drop the entry so the next acquire()
                // re-reads; current awaiters still observe `missing` via the
                // settled promise they already hold.
                cache.delete(cacheKey);
                return;
            }
            entry.resolved = result;
        })
            .catch(() => {
            // A transient IPC failure must not be cached forever. Drop the entry
            // so the next acquire() retries. Current awaiters still surface the
            // error via the promise they already hold; swallowing here only
            // prevents an unhandled rejection.
            if (cache.get(cacheKey) === entry)
                cache.delete(cacheKey);
        });
    }
    if (entry.evictionTimer) {
        clearTimeout(entry.evictionTimer);
        entry.evictionTimer = null;
    }
    entry.refCount += 1;
    return entry;
};
const release = (filePath, entry) => {
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0)
        return;
    if (entry.evictionTimer)
        clearTimeout(entry.evictionTimer);
    entry.evictionTimer = setTimeout(() => {
        if (entry.refCount === 0)
            finalizeEvict(filePath, entry);
    }, CACHE_GRACE_MS);
};
/**
 * Read a file's bytes through the cache. The returned promise resolves
 * once the underlying IPC completes; subsequent callers piggyback on
 * the in-flight or already-resolved entry.
 */
export function useDisplayFileBytes(filePath, unavailableMessage, conversationIdOverride, version, maxBytes) {
    const uiState = useOptionalUiState();
    const conversationId = conversationIdOverride !== undefined
        ? conversationIdOverride
        : (uiState?.state.conversationId ?? null);
    const [bytes, setBytes] = useState(null);
    const [error, setError] = useState(null);
    const [missing, setMissing] = useState(false);
    const [truncated, setTruncated] = useState(false);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setMissing(false);
        setTruncated(false);
        setBytes(null);
        const cacheKey = displayFileCacheKey(filePath, conversationId, version, maxBytes);
        const entry = acquire(filePath, unavailableMessage, conversationId, version, maxBytes);
        void entry.promise
            .then((result) => {
            if (cancelled)
                return;
            if (result.missing) {
                setMissing(true);
                return;
            }
            setBytes(result.bytes);
            setTruncated(result.truncated === true);
        })
            .catch((caught) => {
            if (cancelled)
                return;
            setError(caught instanceof Error ? caught.message : String(caught));
        })
            .finally(() => {
            if (!cancelled)
                setLoading(false);
        });
        return () => {
            cancelled = true;
            release(cacheKey, entry);
        };
    }, [conversationId, filePath, maxBytes, unavailableMessage, version]);
    return { bytes, error, loading, missing, truncated };
}
export function useDisplayFileBlobs(filePaths, unavailableMessage, conversationIdOverride) {
    const uiState = useOptionalUiState();
    const conversationId = conversationIdOverride !== undefined
        ? conversationIdOverride
        : (uiState?.state.conversationId ?? null);
    const [files, setFiles] = useState(() => filePaths.map(() => null));
    const [missing, setMissing] = useState(() => filePaths.map(() => false));
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);
    // `filePaths` reference changes on every render, so key off contents.
    const key = useMemo(() => `${conversationId ?? ""}\0${filePaths.join("|")}`, [conversationId, filePaths]);
    useEffect(() => {
        let cancelled = false;
        const acquired = filePaths.map((filePath) => ({
            cacheKey: displayFileCacheKey(filePath, conversationId),
            entry: acquire(filePath, unavailableMessage, conversationId),
        }));
        // Synchronous fast-path: when every requested file is already
        // resolved in the cache, seed state directly instead of blanking to
        // null first. Blanking would unmount the consuming media element
        // (e.g. <audio>/<video>/<img>) on every selection change and force a
        // visible remount/flash; seeding keeps it mounted and just swaps src.
        const seeded = acquired.map(({ entry }) => {
            const resolved = entry.resolved;
            if (!resolved)
                return undefined;
            if (resolved.missing)
                return { blob: null, missing: true };
            const url = objectUrlFor(entry);
            const blob = entry.blob;
            if (!url || !blob)
                return { blob: null, missing: true };
            return {
                blob: {
                    url,
                    mimeType: resolved.mimeType || "application/octet-stream",
                    blob,
                },
                missing: false,
            };
        });
        if (seeded.every((result) => result !== undefined)) {
            setFiles(seeded.map((result) => result.blob));
            setMissing(seeded.map((result) => result.missing));
            setError(null);
            setLoading(false);
        }
        else {
            setLoading(true);
            setError(null);
            setMissing(filePaths.map(() => false));
            setFiles(filePaths.map(() => null));
        }
        void Promise.all(acquired.map(async ({ entry }) => {
            try {
                await entry.promise;
            }
            catch (caught) {
                if (!cancelled) {
                    setError(caught instanceof Error ? caught.message : String(caught));
                }
                return { blob: null, missing: false };
            }
            if (entry.resolved?.missing) {
                return { blob: null, missing: true };
            }
            const url = objectUrlFor(entry);
            const blob = entry.blob;
            if (!url || !blob)
                return { blob: null, missing: true };
            return {
                blob: {
                    url,
                    mimeType: entry.resolved?.mimeType ?? "application/octet-stream",
                    blob,
                },
                missing: false,
            };
        })).then((results) => {
            if (cancelled)
                return;
            setFiles(results.map((r) => r.blob));
            setMissing(results.map((r) => r.missing));
            setLoading(false);
        });
        return () => {
            cancelled = true;
            // Pair each acquire with its release. The cache's eviction grace
            // window lets a quick remount (e.g. parent re-render flicker)
            // reuse the same Blob/URL instead of re-fetching, so consumers
            // don't see broken images during transient unmount/remount.
            for (const { cacheKey, entry } of acquired)
                release(cacheKey, entry);
        };
    }, [key, unavailableMessage]);
    return { files, error, loading, missing };
}
