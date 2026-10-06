import { isCloudWorkspacePath } from "@stella/contracts/cloud-world-paths";
import type { DeviceFileLocation } from "@stella/contracts/backend/drive";
import {
  deviceFileElsewhereMessage,
  pickDeviceFileLocation,
} from "@stella/contracts/device-files";
import { getBackendClient } from "./backend";
import {
  decodeUtf8,
  isDeviceNotFoundError,
  requestDevice,
} from "./device-requests";
import type { StoredPhoneAccess } from "./phone-access";

/**
 * Files and office previews that live on the paired computer. The phone asks
 * the cloud, the cloud asks the computer over its presence connection, and the
 * bytes stream back through without being stored anywhere. The computer
 * decides what may be read (Stella's own outputs and files from the
 * conversation); see `device-requests.ts` for the offline and refusal errors.
 */

export type DesktopFileReadResult =
  | {
      bytes: Uint8Array;
      sizeBytes: number;
      mimeType: string;
      missing: false;
    }
  | { missing: true; mimeType: string; path: string };

const FILE_READ_TIMEOUT_MS = 120_000;
const OFFICE_PREVIEW_TIMEOUT_MS = 60_000;

const assertActive = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  const error = new Error("Artifact loading cancelled.");
  error.name = "AbortError";
  throw error;
};

/**
 * A cloud-world path asked of the computer is a routing mistake, not a missing
 * file. `/workspace/...` is the cloud sandbox; the paired computer has no such
 * tree, so it would answer "missing" — which the viewer renders as "this file
 * is no longer available". The file is not gone; it was asked of the wrong
 * machine. Drive files never get here: `stellaFileChatArtifact` routes them to
 * the owner-scoped drive URL first.
 */
const assertReadableOnPairedComputer = (filePath: string): void => {
  if (!isCloudWorkspacePath(filePath)) return;
  throw new Error(
    "This file lives in Stella's cloud workspace, not on your computer, so it can't be opened from your phone. Ask Stella to put it in your Drive.",
  );
};

// `async` so a refused path rejects rather than throwing synchronously: one
// caller chains `.then().catch()` straight off this inside an effect, where a
// synchronous throw would escape the catch and take the screen down.
export const readDesktopArtifactFile = async (
  access: StoredPhoneAccess,
  conversationId: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<DesktopFileReadResult> => {
  assertReadableOnPairedComputer(filePath);
  assertActive(signal);
  try {
    const { bytes, contentType } = await requestDevice(
      access,
      "file.read",
      { filePath, conversationId },
      { signal, timeoutMs: FILE_READ_TIMEOUT_MS },
    );
    assertActive(signal);
    return {
      missing: false,
      bytes,
      sizeBytes: bytes.byteLength,
      mimeType: contentType,
    };
  } catch (error) {
    assertActive(signal);
    if (isDeviceNotFoundError(error)) {
      return {
        missing: true,
        mimeType: "application/octet-stream",
        path: filePath,
      };
    }
    throw error;
  }
};

export const locateDeviceFile = async (
  filePath: string,
): Promise<DeviceFileLocation | null> => {
  try {
    const { files } = await getBackendClient().call("drive.locateDeviceFiles", {
      paths: [filePath],
    });
    return pickDeviceFileLocation(files, filePath);
  } catch {
    return null;
  }
};

const readDriveCopy = async (
  drivePath: string,
  signal?: AbortSignal,
): Promise<DesktopFileReadResult> => {
  const file = await getBackendClient().call("drive.fileUrl", {
    path: drivePath,
  });
  const response = await fetch(file.url, { signal });
  if (!response.ok) {
    throw new Error("Couldn't load the copy of this file in your Drive.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    missing: false,
    bytes,
    sizeBytes: bytes.byteLength,
    mimeType: file.contentType || "application/octet-stream",
  };
};

export const readLinkedArtifactFile = async (
  access: StoredPhoneAccess | null,
  conversationId: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<DesktopFileReadResult> => {
  assertReadableOnPairedComputer(filePath);
  const location = await locateDeviceFile(filePath);
  assertActive(signal);
  let copyError: unknown = null;
  if (location?.drivePath) {
    try {
      const copy = await readDriveCopy(location.drivePath, signal);
      assertActive(signal);
      return copy;
    } catch (error) {
      assertActive(signal);
      copyError = error;
    }
  }
  if (copyError && (!access || location?.deviceId !== access.desktopDeviceId)) {
    throw copyError;
  }
  const elsewhere =
    location && location.deviceId !== access?.desktopDeviceId
      ? new Error(deviceFileElsewhereMessage(location.deviceName))
      : null;
  if (!access) {
    throw elsewhere ?? new Error("Pair this phone with your desktop again.");
  }
  try {
    const result = await readDesktopArtifactFile(
      access,
      conversationId,
      filePath,
      signal,
    );
    if (result.missing && elsewhere) throw elsewhere;
    return result;
  } catch (error) {
    assertActive(signal);
    throw elsewhere ?? error;
  }
};

export const bytesToText = (bytes: Uint8Array): string => decodeUtf8(bytes);

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const bytesToBase64 = (bytes: Uint8Array): string => {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    output += BASE64_CHARS[(triple >> 18) & 63];
    output += BASE64_CHARS[(triple >> 12) & 63];
    output += i + 1 < bytes.length ? BASE64_CHARS[(triple >> 6) & 63] : "=";
    output += i + 2 < bytes.length ? BASE64_CHARS[triple & 63] : "=";
  }
  return output;
};

export const bytesToDataUri = (bytes: Uint8Array, mimeType: string): string =>
  `data:${mimeType || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;

const renderOfficePreview = async (
  access: StoredPhoneAccess,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> => {
  assertActive(signal);
  const { bytes } = await requestDevice(access, "officePreview.render", params, {
    signal,
    timeoutMs: OFFICE_PREVIEW_TIMEOUT_MS,
  });
  assertActive(signal);
  return decodeUtf8(bytes);
};

export const loadOfficePreviewHtml = async (
  access: StoredPhoneAccess,
  conversationId: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> => {
  assertReadableOnPairedComputer(filePath);
  return await renderOfficePreview(access, { filePath, conversationId }, signal);
};

export const loadExistingOfficePreviewHtml = (
  access: StoredPhoneAccess,
  conversationId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string> =>
  renderOfficePreview(access, { sessionId, conversationId }, signal);
