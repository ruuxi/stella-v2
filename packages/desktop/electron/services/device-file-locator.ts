import type { DeviceFileLocation, DriveFileUrl } from "@stella/contracts/backend/drive";
import { rpcPath, type RpcResponse } from "@stella/contracts/backend/protocol";

const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const LOCATION_CACHE_TTL_MS = 30_000;

type Deps = {
  getBackendUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
};

export type DeviceFileLocator = {
  locate: (sourcePath: string) => Promise<DeviceFileLocation | null>;
  readCopy: (
    drivePath: string,
    maxBytes: number,
  ) => Promise<{ bytes: Uint8Array; sizeBytes: number; mimeType: string }>;
};

export const createDeviceFileLocator = (deps: Deps): DeviceFileLocator => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cache = new Map<string, { at: number; value: Promise<DeviceFileLocation | null> }>();

  const call = async <T>(name: string, args: unknown): Promise<T> => {
    const baseUrl = deps.getBackendUrl()?.trim().replace(/\/+$/, "");
    const token = await deps.getAuthToken().catch(() => null);
    if (!baseUrl || !token) throw new Error("Sign in to open files from your other devices.");
    const response = await fetchImpl(`${baseUrl}${rpcPath(name)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as RpcResponse<T> | null;
    if (!body) throw new Error(`Stella's backend answered ${response.status}.`);
    if (!body.ok) throw new Error(body.error.message);
    return body.value;
  };

  const locate = (sourcePath: string): Promise<DeviceFileLocation | null> => {
    const now = Date.now();
    const cached = cache.get(sourcePath);
    if (cached && now - cached.at < LOCATION_CACHE_TTL_MS) return cached.value;
    const value = call<{ files: DeviceFileLocation[] }>("drive.locateDeviceFiles", {
      paths: [sourcePath],
    })
      .then((result) => result.files.find((file) => file.sourcePath === sourcePath) ?? null)
      .catch((error: unknown) => {
        cache.delete(sourcePath);
        console.warn(
          "[device-files] Could not look up where this file lives:",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      });
    cache.set(sourcePath, { at: now, value });
    for (const [key, entry] of cache) {
      if (now - entry.at >= LOCATION_CACHE_TTL_MS) cache.delete(key);
    }
    return value;
  };

  const readCopy = async (drivePath: string, maxBytes: number) => {
    const file = await call<DriveFileUrl>("drive.fileUrl", { path: drivePath });
    const response = await fetchImpl(file.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Couldn't download the copy in your Drive (${response.status}).`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (size < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = value.subarray(0, maxBytes - size);
        chunks.push(take);
        size += take.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      sizeBytes: file.sizeBytes,
      mimeType: file.contentType || "application/octet-stream",
    };
  };

  return { locate, readCopy };
};
