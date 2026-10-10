import fs from "node:fs/promises";
import path from "node:path";
import {
  DEVICE_FILE_COPY_LIMITS,
  type DeviceFileSource,
} from "@stella/contracts/device-files";
import type { DeviceFileLocator } from "./device-file-locator.js";

export type DeviceFileSourceDeps = {
  locator: DeviceFileLocator;
  getDeviceId: () => string | null;
};

export type ResolvedDeviceFileSource =
  | { kind: "local"; filePath: string }
  | {
      kind: "drive";
      drivePath: string;
      deviceName: string;
      sizeBytes: number;
      contentType: string;
    }
  | Exclude<DeviceFileSource, { kind: "local" } | { kind: "drive" }>;

const localFilePath = async (requested: string): Promise<string | null> => {
  if (!path.isAbsolute(requested)) return null;
  const resolved = path.resolve(requested);
  const stats = await fs.stat(resolved).catch(() => null);
  return stats?.isFile() ? resolved : null;
};

const wasOnThisComputer = async (requested: string): Promise<boolean> => {
  if (!path.isAbsolute(requested)) return false;
  const parent = await fs.stat(path.dirname(path.resolve(requested))).catch(() => null);
  return parent?.isDirectory() ?? false;
};

/**
 * Where `requested` can be read from. A file on this computer is read here;
 * otherwise the device records say which computer has it and whether it put
 * a copy in the user's Drive. Nothing is downloaded.
 */
export const resolveDeviceFileSource = async (
  requested: string,
  deps: DeviceFileSourceDeps | null,
): Promise<ResolvedDeviceFileSource> => {
  const local = await localFilePath(requested);
  if (local) return { kind: "local", filePath: local };
  const absent = async (): Promise<ResolvedDeviceFileSource> =>
    (await wasOnThisComputer(requested)) ? { kind: "missing" } : { kind: "unshared" };
  if (!deps) return await absent();
  const ownDeviceId = deps.getDeviceId();
  const found = await deps.locator.lookup(requested, ownDeviceId);
  if (!found.ok) {
    return (await wasOnThisComputer(requested))
      ? { kind: "missing" }
      : { kind: "unreachable", message: found.message };
  }
  const location = found.location;
  if (!location) return await absent();
  if (location.drivePath) {
    return {
      kind: "drive",
      drivePath: location.drivePath,
      deviceName: location.deviceName,
      sizeBytes: location.sizeBytes,
      contentType: location.contentType,
    };
  }
  if (location.deviceId === ownDeviceId) return { kind: "missing" };
  return {
    kind: "elsewhere",
    deviceName: location.deviceName,
    oversized: location.sizeBytes > DEVICE_FILE_COPY_LIMITS.maxFileBytes,
  };
};

export const publicDeviceFileSource = (
  source: ResolvedDeviceFileSource,
): DeviceFileSource => {
  if (source.kind === "local") return { kind: "local" };
  if (source.kind === "drive") return { kind: "drive", deviceName: source.deviceName };
  return source;
};
