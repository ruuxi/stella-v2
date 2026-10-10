import type { DeviceFileLocation, DriveFileUrl } from "@stella/contracts/backend/drive";
import { rpcPath, type RpcResponse } from "@stella/contracts/backend/protocol";
import { pickDeviceFileLocation } from "@stella/contracts/device-files";
import { resolveJwtOwnerScope } from "@stella/runtime/kernel/runner/computer-agent-cloud-records";

const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const LOCATION_CACHE_TTL_MS = 30_000;
const COPY_URL_EXPIRY_MARGIN_MS = 60_000;
const SIGNED_OUT_MESSAGE = "Sign in to open files from your other devices.";

type Deps = {
  getBackendUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
};

export type DeviceFileLookup =
  | { ok: true; location: DeviceFileLocation | null }
  | { ok: false; message: string };

export type DeviceFileLocator = {
  locate: (
    sourcePath: string,
    readerDeviceId?: string | null,
  ) => Promise<DeviceFileLocation | null>;
  lookup: (
    sourcePath: string,
    readerDeviceId?: string | null,
  ) => Promise<DeviceFileLookup>;
  copyUrl: (drivePath: string, options?: { fresh?: boolean }) => Promise<DriveFileUrl>;
  readCopy: (
    drivePath: string,
    maxBytes: number,
  ) => Promise<{ bytes: Uint8Array; sizeBytes: number; mimeType: string }>;
};

type Candidates = { ok: true; files: DeviceFileLocation[] } | { ok: false; message: string };

type CopyUrlEntry = {
  owner: string;
  value: Promise<DriveFileUrl>;
  file: DriveFileUrl | null;
};

export const createDeviceFileLocator = (deps: Deps): DeviceFileLocator => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cache = new Map<string, { at: number; value: Promise<Candidates> }>();
  const copyUrls = new Map<string, CopyUrlEntry>();

  const call = async <T>(name: string, args: unknown): Promise<T> => {
    const baseUrl = deps.getBackendUrl()?.trim().replace(/\/+$/, "");
    const token = await deps.getAuthToken().catch(() => null);
    if (!baseUrl || !token) throw new Error(SIGNED_OUT_MESSAGE);
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

  const currentOwner = async (): Promise<string | null> =>
    resolveJwtOwnerScope(await deps.getAuthToken().catch(() => null));

  const candidates = async (sourcePath: string): Promise<Candidates> => {
    const baseUrl = deps.getBackendUrl()?.trim() ?? "";
    const owner = await currentOwner();
    if (!baseUrl || !owner) return { ok: false, message: SIGNED_OUT_MESSAGE };
    const cacheKey = `${baseUrl}\0${owner}\0${sourcePath}`;
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && now - cached.at < LOCATION_CACHE_TTL_MS) return await cached.value;
    const value = call<{ files: DeviceFileLocation[] }>("drive.locateDeviceFiles", {
      paths: [sourcePath],
    })
      .then((result): Candidates => ({ ok: true, files: result.files }))
      .catch((error: unknown): Candidates => {
        cache.delete(cacheKey);
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[device-files] Could not look up where this file lives:", message);
        return { ok: false, message };
      });
    cache.set(cacheKey, { at: now, value });
    for (const [key, entry] of cache) {
      if (now - entry.at >= LOCATION_CACHE_TTL_MS) cache.delete(key);
    }
    return await value;
  };

  const lookup = async (
    sourcePath: string,
    readerDeviceId?: string | null,
  ): Promise<DeviceFileLookup> => {
    const found = await candidates(sourcePath);
    if (!found.ok) return found;
    return {
      ok: true,
      location: pickDeviceFileLocation(found.files, sourcePath, readerDeviceId),
    };
  };

  const locate = async (sourcePath: string, readerDeviceId?: string | null) => {
    const found = await lookup(sourcePath, readerDeviceId);
    return found.ok ? found.location : null;
  };

  const copyUrl = async (drivePath: string, options?: { fresh?: boolean }) => {
    const owner = (await currentOwner()) ?? "";
    const now = Date.now();
    for (const [key, entry] of copyUrls) {
      if (entry.file && entry.file.expiresAt <= now) copyUrls.delete(key);
    }
    const cached = copyUrls.get(drivePath);
    if (cached && cached.owner === owner && !options?.fresh) {
      const file = await cached.value.catch(() => null);
      if (file && file.expiresAt - COPY_URL_EXPIRY_MARGIN_MS > Date.now()) return file;
    }
    const entry: CopyUrlEntry = {
      owner,
      value: call<DriveFileUrl>("drive.fileUrl", { path: drivePath }),
      file: null,
    };
    copyUrls.set(drivePath, entry);
    entry.value.then(
      (file) => {
        entry.file = file;
      },
      () => {
        if (copyUrls.get(drivePath) === entry) copyUrls.delete(drivePath);
      },
    );
    return await entry.value;
  };

  const readCopy = async (drivePath: string, maxBytes: number) => {
    const file = await copyUrl(drivePath);
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

  return { locate, lookup, copyUrl, readCopy };
};
