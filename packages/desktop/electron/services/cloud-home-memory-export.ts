import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const MAX_MEMORY_DOCUMENT_BYTES = 512 * 1024;
const MAX_PENDING_EXPORTS = 128;
const DEFAULT_EXPORT_TTL_MS = 2 * 60 * 1_000;
const SAFE_MARKDOWN_BASENAME = /^[^/\\\u0000-\u001f\u007f]{1,93}\.md$/iu;
const EXPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type CloudHomeMemoryExportAuthority = Readonly<{
  expectedSubject: string;
  ownerGeneration: string;
  memoryEpoch: string;
  lifecycleState: "open";
}>;

export type BeginCloudHomeMemoryExportPayload =
  CloudHomeMemoryExportAuthority & {
    suggestedName: string;
  };

export type CommitCloudHomeMemoryExportPayload =
  CloudHomeMemoryExportAuthority & {
    exportId: string;
    content: string;
  };

export type BeginCloudHomeMemoryExportResult =
  | { ok: true; exportId: string }
  | { ok: false; canceled: true };

export type CommitCloudHomeMemoryExportResult =
  | { ok: true }
  | { ok: false; canceled: true };

type SaveDialog = (options: {
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
  properties: Array<"createDirectory" | "showOverwriteConfirmation">;
}) => Promise<{ canceled: boolean; filePath?: string }>;

type PendingExport = {
  senderId: number;
  authority: CloudHomeMemoryExportAuthority;
  filePath: string;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length && expected.every((key) => key in value)
  );
};

const normalizeAuthorityToken = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.normalize("NFC") !== value ||
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new TypeError("The memory export authority was invalid.");
  }
  return value;
};

const normalizeAuthority = (
  value: Record<string, unknown>,
): CloudHomeMemoryExportAuthority => {
  if (value.lifecycleState !== "open") {
    throw new TypeError("The memory export lifecycle was not open.");
  }
  return Object.freeze({
    expectedSubject: normalizeAuthorityToken(value.expectedSubject),
    ownerGeneration: normalizeAuthorityToken(value.ownerGeneration),
    memoryEpoch: normalizeAuthorityToken(value.memoryEpoch),
    lifecycleState: "open" as const,
  });
};

const normalizeSuggestedName = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.normalize("NFC") !== value ||
    value.trim() !== value ||
    !SAFE_MARKDOWN_BASENAME.test(value) ||
    value === ".md"
  ) {
    throw new TypeError("The memory document was invalid.");
  }
  return value;
};

const normalizeExportId = (value: unknown): string => {
  if (typeof value !== "string" || !EXPORT_ID_PATTERN.test(value)) {
    throw new TypeError("The memory export operation was invalid.");
  }
  return value;
};

const normalizeContent = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("The memory document was invalid.");
  }
  const sizeBytes = Buffer.byteLength(value, "utf8");
  if (sizeBytes < 1 || sizeBytes > MAX_MEMORY_DOCUMENT_BYTES) {
    throw new TypeError("The memory document was outside its size limit.");
  }
  return value;
};

const normalizeBeginPayload = (
  payload: unknown,
): BeginCloudHomeMemoryExportPayload => {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, [
      "suggestedName",
      "expectedSubject",
      "ownerGeneration",
      "memoryEpoch",
      "lifecycleState",
    ])
  ) {
    throw new TypeError("The memory document was invalid.");
  }
  return {
    suggestedName: normalizeSuggestedName(payload.suggestedName),
    ...normalizeAuthority(payload),
  };
};

const normalizeCommitPayload = (
  payload: unknown,
): CommitCloudHomeMemoryExportPayload => {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, [
      "exportId",
      "content",
      "expectedSubject",
      "ownerGeneration",
      "memoryEpoch",
      "lifecycleState",
    ])
  ) {
    throw new TypeError("The memory document was invalid.");
  }
  return {
    exportId: normalizeExportId(payload.exportId),
    content: normalizeContent(payload.content),
    ...normalizeAuthority(payload),
  };
};

const sameAuthority = (
  left: CloudHomeMemoryExportAuthority,
  right: CloudHomeMemoryExportAuthority,
): boolean =>
  left.expectedSubject === right.expectedSubject &&
  left.ownerGeneration === right.ownerGeneration &&
  left.memoryEpoch === right.memoryEpoch &&
  left.lifecycleState === right.lifecycleState;

/**
 * Native destinations stay in main-process memory behind a short-lived,
 * sender-bound opaque id. The picker never receives document content and the
 * renderer never receives the selected path. A fresh cloud authority check can
 * therefore happen between selection and the single-use commit.
 */
export const createCloudHomeMemoryExportService = (options?: {
  now?: () => number;
  createId?: () => string;
  ttlMs?: number;
  write?: typeof writeFile;
}) => {
  const now = options?.now ?? Date.now;
  const createId = options?.createId ?? randomUUID;
  const ttlMs = options?.ttlMs ?? DEFAULT_EXPORT_TTL_MS;
  const write = options?.write ?? writeFile;
  const pending = new Map<string, PendingExport>();

  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 10 * 60 * 1_000) {
    throw new TypeError("The memory export lifetime was invalid.");
  }

  const remove = (exportId: string): PendingExport | null => {
    const operation = pending.get(exportId);
    if (!operation) return null;
    pending.delete(exportId);
    clearTimeout(operation.expiryTimer);
    return operation;
  };

  const purgeExpired = (): void => {
    const currentTime = now();
    for (const [exportId, operation] of pending) {
      if (operation.expiresAt <= currentTime) remove(exportId);
    }
  };

  const begin = async (args: {
    senderId: number;
    payload: unknown;
    showSaveDialog: SaveDialog;
    isSenderAlive?: () => boolean;
  }): Promise<BeginCloudHomeMemoryExportResult> => {
    if (!Number.isSafeInteger(args.senderId) || args.senderId < 0) {
      throw new TypeError("The memory export sender was invalid.");
    }
    const payload = normalizeBeginPayload(args.payload);
    purgeExpired();
    if (pending.size >= MAX_PENDING_EXPORTS) {
      throw new Error("Too many memory exports are pending.");
    }
    const selection = await args.showSaveDialog({
      defaultPath: payload.suggestedName,
      filters: [{ name: "Markdown", extensions: ["md"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (
      selection.canceled ||
      !selection.filePath ||
      args.isSenderAlive?.() === false
    ) {
      return { ok: false, canceled: true };
    }

    const exportId = normalizeExportId(createId());
    if (pending.has(exportId)) {
      throw new Error("The memory export operation could not be created.");
    }
    const expiresAt = now() + ttlMs;
    const expiryTimer = setTimeout(() => {
      remove(exportId);
    }, ttlMs);
    expiryTimer.unref?.();
    pending.set(exportId, {
      senderId: args.senderId,
      authority: payload,
      filePath: selection.filePath,
      expiresAt,
      expiryTimer,
    });
    return { ok: true, exportId };
  };

  const commit = async (args: {
    senderId: number;
    payload: unknown;
  }): Promise<CommitCloudHomeMemoryExportResult> => {
    if (!Number.isSafeInteger(args.senderId) || args.senderId < 0) {
      throw new TypeError("The memory export sender was invalid.");
    }
    const payload = normalizeCommitPayload(args.payload);
    const operation = pending.get(payload.exportId);
    if (!operation) return { ok: false, canceled: true };
    if (operation.expiresAt <= now()) {
      remove(payload.exportId);
      return { ok: false, canceled: true };
    }
    // A different privileged renderer cannot consume an operation it does not
    // own, even if it somehow learns the opaque id.
    if (operation.senderId !== args.senderId) {
      return { ok: false, canceled: true };
    }
    remove(payload.exportId);
    if (!sameAuthority(operation.authority, payload)) {
      return { ok: false, canceled: true };
    }
    await write(operation.filePath, payload.content, "utf8");
    return { ok: true };
  };

  const cancel = (args: {
    senderId: number;
    payload: unknown;
  }): { ok: true } => {
    if (!Number.isSafeInteger(args.senderId) || args.senderId < 0) {
      throw new TypeError("The memory export sender was invalid.");
    }
    if (!isRecord(args.payload) || !hasExactKeys(args.payload, ["exportId"])) {
      throw new TypeError("The memory export operation was invalid.");
    }
    const exportId = normalizeExportId(args.payload.exportId);
    const operation = pending.get(exportId);
    if (operation?.senderId === args.senderId) remove(exportId);
    return { ok: true };
  };

  const cancelForSender = (senderId: number): void => {
    for (const [exportId, operation] of pending) {
      if (operation.senderId === senderId) remove(exportId);
    }
  };

  return Object.freeze({ begin, commit, cancel, cancelForSender });
};
