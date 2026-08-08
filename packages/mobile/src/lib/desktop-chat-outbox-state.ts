import type { ChatMessage } from "../types";

export type DesktopChatOutboxAsset = {
  uri: string;
  width: number;
  height: number;
  base64?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number;
  type?: "image" | "video" | "livePhoto" | "pairedVideo" | null;
};

export type DesktopChatOutboxRecord = {
  sendId: string;
  userMessageId: string;
  text: string;
  displayText: string;
  createdAt: number;
  sequence: number;
  assets: DesktopChatOutboxAsset[];
};

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const parseAsset = (value: unknown): DesktopChatOutboxAsset | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const uri = typeof record.uri === "string" ? record.uri.trim() : "";
  const width = finiteNumber(record.width);
  const height = finiteNumber(record.height);
  if (!uri || width === null || height === null) return null;
  return {
    uri,
    width,
    height,
    ...(typeof record.base64 === "string" || record.base64 === null
      ? { base64: record.base64 }
      : {}),
    ...(typeof record.mimeType === "string" || record.mimeType === null
      ? { mimeType: record.mimeType }
      : {}),
    ...(typeof record.fileName === "string" || record.fileName === null
      ? { fileName: record.fileName }
      : {}),
    ...(finiteNumber(record.fileSize) !== null
      ? { fileSize: record.fileSize as number }
      : {}),
    ...(record.type === "image" ||
    record.type === "video" ||
    record.type === "livePhoto" ||
    record.type === "pairedVideo" ||
    record.type === null
      ? { type: record.type }
      : {}),
  };
};

export const parseDesktopChatOutbox = (
  value: unknown,
): DesktopChatOutboxRecord[] => {
  if (!Array.isArray(value)) return [];
  const bySendId = new Map<string, DesktopChatOutboxRecord>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const sendId = typeof record.sendId === "string" ? record.sendId.trim() : "";
    const userMessageId =
      typeof record.userMessageId === "string"
        ? record.userMessageId.trim()
        : "";
    const text = typeof record.text === "string" ? record.text : "";
    const displayText =
      typeof record.displayText === "string" ? record.displayText : text;
    const createdAt = finiteNumber(record.createdAt);
    const sequence = finiteNumber(record.sequence);
    if (!sendId || !userMessageId || createdAt === null || sequence === null) {
      continue;
    }
    const assets = Array.isArray(record.assets)
      ? record.assets
          .map(parseAsset)
          .filter((asset): asset is DesktopChatOutboxAsset => Boolean(asset))
      : [];
    bySendId.set(sendId, {
      sendId,
      userMessageId,
      text,
      displayText,
      createdAt,
      sequence,
      assets,
    });
  }
  return [...bySendId.values()].sort(
    (a, b) => a.sequence - b.sequence || a.sendId.localeCompare(b.sendId),
  );
};

export const appendDesktopChatOutboxRecord = (
  current: DesktopChatOutboxRecord[],
  input: Omit<DesktopChatOutboxRecord, "sequence">,
): { records: DesktopChatOutboxRecord[]; record: DesktopChatOutboxRecord } => {
  const normalized = parseDesktopChatOutbox(current);
  const existing = normalized.find((record) => record.sendId === input.sendId);
  if (existing) return { records: normalized, record: existing };
  const sequence = normalized.reduce(
    (highest, record) => Math.max(highest, record.sequence),
    0,
  ) + 1;
  const record = { ...input, sequence };
  return { records: [...normalized, record], record };
};

export const acknowledgeDesktopChatOutboxRecords = (
  current: DesktopChatOutboxRecord[],
  acceptedIds: ReadonlySet<string>,
): DesktopChatOutboxRecord[] =>
  parseDesktopChatOutbox(current).filter(
    (record) =>
      !acceptedIds.has(record.sendId) &&
      !acceptedIds.has(record.userMessageId),
  );

export const restoreOutboxMessages = (
  messages: ChatMessage[],
  outbox: DesktopChatOutboxRecord[],
): ChatMessage[] => {
  const existingIds = new Set(messages.map((message) => message.id));
  const restored = [...messages];
  for (const record of parseDesktopChatOutbox(outbox)) {
    if (existingIds.has(record.userMessageId)) continue;
    existingIds.add(record.userMessageId);
    restored.push({
      id: record.userMessageId,
      role: "user",
      text: record.displayText,
      createdAt: record.createdAt,
      queued: true,
      ...(record.assets.length > 0
        ? {
            hasImage: true,
            thumbnailUris: record.assets.slice(0, 3).map((asset) => asset.uri),
          }
        : {}),
    });
  }
  return restored;
};
