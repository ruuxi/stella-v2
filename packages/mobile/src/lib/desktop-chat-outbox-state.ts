import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { parseCloudModelSelection } from "./cloud-model-selection";
import type { ChatMessage } from "../types";
import type { AutomaticExecutionTarget } from "./execution-placement";

/**
 * An attachment a queued row carries. The bytes are not here: they reached the
 * owner's drive before the row was ever written, so replay only needs the path
 * that names them. `previewUri` is the local thumbnail and is allowed to be
 * missing — a picked photo's cache entry does not have to survive a restart for
 * the turn to.
 */
export type DesktopChatOutboxAttachment = {
  path: string;
  name: string;
  kind: "image" | "file";
  previewUri?: string;
};

export type DesktopChatOutboxAuthority = {
  accountScope: string;
  ownerGeneration: string;
  conversationId: string;
};

export type DesktopChatOutboxRecord = {
  sendId: string;
  userMessageId: string;
  /** Journal echo identity; absent on pre-upgrade rows to preserve their hash. */
  userMessageEventId?: string;
  text: string;
  displayText: string;
  createdAt: number;
  sequence: number;
  attachments: DesktopChatOutboxAttachment[];
  executionTarget?: AutomaticExecutionTarget;
  execution?: CloudExecutionSelection;
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

const parseAttachment = (
  value: unknown,
): DesktopChatOutboxAttachment | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!path || path.length > 400 || !name || name.length > 255) return null;
  const kind = record.kind === "image" ? "image" : "file";
  const previewUri =
    typeof record.previewUri === "string" ? record.previewUri.trim() : "";
  return {
    path,
    name,
    kind,
    ...(previewUri ? { previewUri } : {}),
  };
};

const parseExecutionTarget = (
  value: unknown,
): AutomaticExecutionTarget | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "automatic" || record.mode === "cloud") {
    return { mode: record.mode };
  }
  if (
    record.mode === "device" &&
    typeof record.deviceId === "string" &&
    record.deviceId.trim()
  ) {
    return { mode: "device", deviceId: record.deviceId.trim() };
  }
  return undefined;
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
    const attachments = Array.isArray(record.attachments)
      ? record.attachments
          .map(parseAttachment)
          .filter((entry): entry is DesktopChatOutboxAttachment =>
            Boolean(entry),
          )
      : [];
    const authority = parseAuthority(record.authority);
    const executionTarget = parseExecutionTarget(record.executionTarget);
    const execution = executionTarget?.mode !== "device"
      ? parseCloudModelSelection(record.execution)
      : undefined;
    const parsed = {
      sendId,
      userMessageId,
      ...(record.userMessageEventId === userMessageId ? { userMessageEventId: userMessageId } : {}),
      text,
      displayText,
      createdAt,
      sequence,
      attachments,
      ...(executionTarget ? { executionTarget } : {}),
      ...(execution ? { execution } : {}),
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
  const { execution: inputExecution, ...rest } = input;
  const execution = input.executionTarget?.mode !== "device"
    ? parseCloudModelSelection(inputExecution)
    : undefined;
  const record = { ...rest, sequence, ...(execution ? { execution } : {}) };
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

/**
 * What a restored bubble shows for its attachments. An image counts even when
 * its local preview is gone: the turn still carries the photo, and claiming
 * otherwise would render the bubble as text-only.
 */
const outboxAttachmentPreview = (record: DesktopChatOutboxRecord) => {
  const images = record.attachments.filter((entry) => entry.kind === "image");
  return {
    hasImage: images.length > 0,
    thumbnailUris: images
      .flatMap((entry) => (entry.previewUri ? [entry.previewUri] : []))
      .slice(0, 3),
    documentNames: record.attachments
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.name),
  };
};

export const restoreOutboxMessages = (
  messages: ChatMessage[],
  outbox: DesktopChatOutboxRecord[],
): ChatMessage[] => {
  const existingIds = new Set(messages.map((message) => message.id));
  const restored = [...messages];
  for (const record of parseDesktopChatOutbox(outbox)) {
    if (existingIds.has(record.userMessageId)) continue;
    existingIds.add(record.userMessageId);
    const preview = outboxAttachmentPreview(record);
    restored.push({
      id: record.userMessageId,
      role: "user",
      text: record.displayText,
      createdAt: record.createdAt,
      queued: true,
      ...(preview.hasImage ? { hasImage: true } : {}),
      ...(preview.thumbnailUris.length > 0
        ? { thumbnailUris: preview.thumbnailUris }
        : {}),
      ...(preview.documentNames.length > 0
        ? { documentNames: preview.documentNames }
        : {}),
    });
  }
  return restored;
};
