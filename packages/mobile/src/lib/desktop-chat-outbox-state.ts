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

export type DesktopChatOutboxAuthority = {
  accountScope: string;
  ownerGeneration: string;
  conversationId: string;
};

export type DesktopChatOutboxRecord = {
  sendId: string;
  userMessageId: string;
  text: string;
  displayText: string;
  createdAt: number;
  sequence: number;
  assets: DesktopChatOutboxAsset[];
  /** Exact server owner fence for canonical journal replay. */
  authority?: DesktopChatOutboxAuthority;
  /** Durable placement cancel intent, retained until the server is terminal. */
  cancelRequestId?: string;
  cancelRequestedAt?: number;
};

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const parseAuthority = (
  value: unknown,
): DesktopChatOutboxAuthority | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const accountScope =
    typeof record.accountScope === "string" ? record.accountScope.trim() : "";
  const ownerGeneration =
    typeof record.ownerGeneration === "string"
      ? record.ownerGeneration.trim()
      : "";
  const conversationId =
    typeof record.conversationId === "string"
      ? record.conversationId.trim()
      : "";
  if (
    !accountScope ||
    accountScope.length > 512 ||
    !ownerGeneration ||
    ownerGeneration.length > 512 ||
    !conversationId ||
    conversationId.length > 512
  ) {
    return undefined;
  }
  return { accountScope, ownerGeneration, conversationId };
};

export const desktopChatOutboxAuthorityMatches = (
  record: DesktopChatOutboxRecord,
  authority: DesktopChatOutboxAuthority,
): boolean =>
  record.authority?.accountScope === authority.accountScope &&
  record.authority.ownerGeneration === authority.ownerGeneration &&
  record.authority.conversationId === authority.conversationId;

/**
 * Exact-scope rows may replay. Rows from another account (or a legacy build)
 * remain quarantined; stale generations/conversations for this same account
 * are deleted because they can never become valid again.
 */
export const partitionDesktopChatOutboxForAuthority = (
  records: DesktopChatOutboxRecord[],
  authority: DesktopChatOutboxAuthority,
): {
  active: DesktopChatOutboxRecord[];
  retained: DesktopChatOutboxRecord[];
  stale: DesktopChatOutboxRecord[];
} => {
  const active: DesktopChatOutboxRecord[] = [];
  const retained: DesktopChatOutboxRecord[] = [];
  const stale: DesktopChatOutboxRecord[] = [];
  for (const record of records) {
    if (desktopChatOutboxAuthorityMatches(record, authority)) {
      active.push(record);
      retained.push(record);
    } else if (record.authority?.accountScope === authority.accountScope) {
      stale.push(record);
    } else {
      retained.push(record);
    }
  }
  return { active, retained, stale };
};

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

const recordScopeKey = (record: {
  sendId: string;
  authority?: DesktopChatOutboxAuthority;
}): string =>
  JSON.stringify([
    record.authority?.accountScope ?? null,
    record.authority?.ownerGeneration ?? null,
    record.authority?.conversationId ?? null,
    record.sendId,
  ]);

export const parseDesktopChatOutbox = (
  value: unknown,
): DesktopChatOutboxRecord[] => {
  if (!Array.isArray(value)) return [];
  const bySendId = new Map<string, DesktopChatOutboxRecord>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const sendId =
      typeof record.sendId === "string" ? record.sendId.trim() : "";
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
    const authority = parseAuthority(record.authority);
    const parsed = {
      sendId,
      userMessageId,
      text,
      displayText,
      createdAt,
      sequence,
      assets,
      ...(authority ? { authority } : {}),
      ...(typeof record.cancelRequestId === "string" &&
      record.cancelRequestId.trim()
        ? { cancelRequestId: record.cancelRequestId.trim() }
        : {}),
      ...(finiteNumber(record.cancelRequestedAt) !== null
        ? { cancelRequestedAt: record.cancelRequestedAt as number }
        : {}),
    };
    bySendId.set(recordScopeKey(parsed), parsed);
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
  const inputKey = recordScopeKey(input);
  const existing = normalized.find(
    (record) => recordScopeKey(record) === inputKey,
  );
  if (existing) {
    const normalizedInput = parseDesktopChatOutbox([
      { ...input, sequence: existing.sequence },
    ])[0];
    if (
      !normalizedInput ||
      JSON.stringify(existing) !== JSON.stringify(normalizedInput)
    ) {
      throw new Error("Conflicting durable chat outbox identity");
    }
    return { records: normalized, record: existing };
  }
  const sequence =
    normalized.reduce(
      (highest, record) => Math.max(highest, record.sequence),
      0,
    ) + 1;
  const record = { ...input, sequence };
  return { records: [...normalized, record], record };
};

export const acknowledgeDesktopChatOutboxRecords = (
  current: DesktopChatOutboxRecord[],
  acceptedIds: ReadonlySet<string>,
  authority?: DesktopChatOutboxAuthority,
): DesktopChatOutboxRecord[] =>
  parseDesktopChatOutbox(current).filter(
    (record) =>
      (authority && !desktopChatOutboxAuthorityMatches(record, authority)) ||
      (!acceptedIds.has(record.sendId) &&
        !acceptedIds.has(record.userMessageId)),
  );

export const markDesktopChatOutboxRecordCanceled = (
  current: DesktopChatOutboxRecord[],
  sendId: string,
  cancelRequestId: string,
  cancelRequestedAt: number,
  authority?: DesktopChatOutboxAuthority,
): DesktopChatOutboxRecord[] =>
  parseDesktopChatOutbox(current).map((record) =>
    (record.sendId === sendId || record.userMessageId === sendId) &&
    (!authority || desktopChatOutboxAuthorityMatches(record, authority))
      ? {
          ...record,
          cancelRequestId,
          cancelRequestedAt,
        }
      : record,
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
