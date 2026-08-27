export type DisplayFileBlob = {
    url: string;
    mimeType: string;
    blob: Blob;
};

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
