import {
  fetchDesktopBridgeFileBytes,
  invokeDesktopBridge,
  resolveDesktopBridge,
  type DesktopBridgeConnection,
} from "./desktop-bridge-chat";
import type { StoredPhoneAccess } from "./phone-access";

export type DesktopFileReadResult =
  | {
      bytes: Uint8Array;
      sizeBytes: number;
      mimeType: string;
      missing: false;
    }
  | { missing: true; mimeType: string; path: string };

export type OfficePreviewSnapshot = {
  sessionId: string;
  title: string;
  sourcePath: string;
  format: "docx" | "xlsx" | "pptx" | null;
  startedAt: number;
  updatedAt: number;
  status: "starting" | "ready" | "error" | "stopped";
  html: string;
  error?: string;
};

const OFFICE_PREVIEW_TIMEOUT_MS = 30_000;
const OFFICE_PREVIEW_POLL_MS = 750;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => /^\d+$/.test(key))
      .map(Number)
      .sort((a, b) => a - b);
    return new Uint8Array(
      keys.map((key) =>
        typeof record[String(key)] === "number"
          ? (record[String(key)] as number)
          : 0,
      ),
    );
  }
  return new Uint8Array();
};

export async function readDesktopArtifactFile(
  bridge: DesktopBridgeConnection,
  conversationId: string,
  filePath: string,
): Promise<DesktopFileReadResult> {
  // Prefer the encrypted-binary lane (~1.0x wire size). Any failure — feature
  // missing (returns null), transport hiccup — falls back to the legacy
  // JSON-serialized `display:readFile` invoke below.
  try {
    const binary = await fetchDesktopBridgeFileBytes(
      bridge,
      conversationId,
      filePath,
    );
    if (binary) {
      return binary.missing
        ? { missing: true, mimeType: binary.mimeType, path: binary.path }
        : {
            missing: false,
            bytes: binary.bytes,
            sizeBytes: binary.sizeBytes,
            mimeType: binary.mimeType,
          };
    }
  } catch {
    // fall through to the legacy lane
  }

  const result = await invokeDesktopBridge<Record<string, unknown>>(
    bridge,
    "display:readFile",
    [{ filePath, conversationId }],
  );
  if (result?.missing === true) {
    return {
      missing: true,
      mimeType:
        typeof result.mimeType === "string"
          ? result.mimeType
          : "application/octet-stream",
      path: typeof result.path === "string" ? result.path : filePath,
    };
  }
  return {
    missing: false,
    bytes: normalizeBytes(result?.bytes),
    sizeBytes: typeof result?.sizeBytes === "number" ? result.sizeBytes : 0,
    mimeType:
      typeof result?.mimeType === "string"
        ? result.mimeType
        : "application/octet-stream",
  };
}

export const bytesToText = (bytes: Uint8Array): string => {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
};

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

export const resolveArtifactBridge = async (
  access: StoredPhoneAccess,
): Promise<DesktopBridgeConnection> => resolveDesktopBridge(access);

export async function loadOfficePreviewHtml(
  bridge: DesktopBridgeConnection,
  conversationId: string,
  filePath: string,
): Promise<string> {
  const ref = await invokeDesktopBridge<{ sessionId: string }>(
    bridge,
    "officePreview:start",
    [{ filePath, conversationId }],
  );
  const started = Date.now();
  while (Date.now() - started < OFFICE_PREVIEW_TIMEOUT_MS) {
    const snapshots = await invokeDesktopBridge<OfficePreviewSnapshot[]>(
      bridge,
      "officePreview:list",
      [{ conversationId }],
    );
    const snapshot = snapshots.find(
      (entry) => entry.sessionId === ref.sessionId,
    );
    if (snapshot?.status === "ready" && snapshot.html) return snapshot.html;
    if (snapshot?.status === "error") {
      throw new Error(snapshot.error || "Office preview failed.");
    }
    await sleep(OFFICE_PREVIEW_POLL_MS);
  }
  throw new Error("Office preview timed out.");
}

export async function loadExistingOfficePreviewHtml(
  bridge: DesktopBridgeConnection,
  conversationId: string,
  sessionId: string,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < OFFICE_PREVIEW_TIMEOUT_MS) {
    const snapshots = await invokeDesktopBridge<OfficePreviewSnapshot[]>(
      bridge,
      "officePreview:list",
      [{ conversationId }],
    );
    const snapshot = snapshots.find((entry) => entry.sessionId === sessionId);
    if (snapshot?.status === "ready" && snapshot.html) return snapshot.html;
    if (snapshot?.status === "error") {
      throw new Error(snapshot.error || "Office preview failed.");
    }
    await sleep(OFFICE_PREVIEW_POLL_MS);
  }
  throw new Error("Office preview timed out.");
}
