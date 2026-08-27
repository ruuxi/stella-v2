export type DisplayFileBlob = {
    url: string;
    mimeType: string;
    blob: Blob;
};
/**
 * Read a file's bytes through the cache. The returned promise resolves
 * once the underlying IPC completes; subsequent callers piggyback on
 * the in-flight or already-resolved entry.
 */
export declare function useDisplayFileBytes(filePath: string, unavailableMessage?: string, conversationIdOverride?: string | null, version?: string | number, maxBytes?: number): {
    bytes: Uint8Array | null;
    error: string | null;
    loading: boolean;
    missing: boolean;
    truncated: boolean;
};
export declare function useDisplayFileBlobs(filePaths: string[], unavailableMessage?: string, conversationIdOverride?: string | null): {
    files: Array<DisplayFileBlob | null>;
    error: string | null;
    loading: boolean;
    missing: boolean[];
};
