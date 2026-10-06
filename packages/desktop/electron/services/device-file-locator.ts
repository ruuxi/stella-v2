import type { DeviceFileLocation, DriveFileUrl } from "@stella/contracts/backend/drive";
import { rpcPath, type RpcResponse } from "@stella/contracts/backend/protocol";
import { pickDeviceFileLocation } from "@stella/contracts/device-files";
import { resolveJwtOwnerScope } from "@stella/runtime/kernel/runner/computer-agent-cloud-records";

const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const LOCATION_CACHE_TTL_MS = 30_000;

type Deps = {
  getBackendUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
};

export type DeviceFileLocator = {
  locate: (
    sourcePath: string,
    readerDeviceId?: string | null,
  ) => Promise<DeviceFileLocation | null>;
  readCopy: (
    drivePath: string,
    maxBytes: number,
  ) => Promise<{ bytes: Uint8Array; sizeBytes: number; mimeType: string }>;
};

export const createDeviceFileLocator = (deps: Deps): DeviceFileLocator => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cache = new Map<string, { at: number; value: Promise<DeviceFileLocation[]> }>();

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

  const candidates = async (sourcePath: string): Promise<DeviceFileLocation[]> => {
    const baseUrl = deps.getBackendUrl()?.trim() ?? "";
    const token = await deps.getAuthToken().catch(() => null);
    const owner = resolveJwtOwnerScope(token);
    if (!baseUrl || !owner) return [];
    const cacheKey = `${baseUrl}\0${owner}\0${sourcePath}`;
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && now - cached.at < LOCATION_CACHE_TTL_MS) return await cached.value;
    const value = call<{ files: DeviceFileLocation[] }>("drive.locateDeviceFiles", {
      paths: [sourcePath],
    })
      .then((result) => result.files)
      .catch((error: unknown) => {
        cache.delete(cacheKey);
        console.warn(
          "[device-files] Could not look up where this file lives:",
          error instanceof Error ? error.message : String(error),
        );
        return [] as DeviceFileLocation[];
      });
    cache.set(cacheKey, { at: now, value });
    for (const [key, entry] of cache) {
      if (now - entry.at >= LOCATION_CACHE_TTL_MS) cache.delete(key);
    }
    return await value;
  };

  const locate = async (sourcePath: string, readerDeviceId?: string | null) =>
    pickDeviceFileLocation(await candidates(sourcePath), sourcePath, readerDeviceId);

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
