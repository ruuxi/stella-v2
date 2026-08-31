import type { EventRecord } from "@stella/contracts/local-chat";
import { eventContributesFiles } from "@/features/workspace-display/agent-files";
import { messageText, type JournalRecord } from "./conversation-protocol";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const timestampOf = (
  payload: Record<string, unknown>,
  fallback: number,
): number =>
  typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)
    ? payload.timestamp
    : fallback;

/**
 * Agent completion wakes are durable hidden user rows. Their matching files
 * card is keyed to the wake turn, so this stable marker lets the Files
 * projection retain per-agent attribution without consulting desktop SQLite.
 */
const agentThreadIdFromWakePrompt = (
  record: Extract<JournalRecord, { kind: "message" }>,
): string | null => {
  if (record.role !== "user" || record.payload.source !== "agent-thread") {
    return null;
  }
  return /\(thread ([^)]+)\)/u.exec(messageText(record.payload))?.[1] ?? null;
};

const agentThreadIdsByTurn = (
  records: readonly JournalRecord[],
): ReadonlyMap<string, string> => {
  const result = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== "message") continue;
    const threadId = agentThreadIdFromWakePrompt(record);
    if (threadId) result.set(record.turnId, threadId);
  }
  return result;
};

const copyStructuredActivityFields = (
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const key of [
    "agentId",
    "agentType",
    "slug",
    "title",
    "createdAt",
  ] as const) {
    if (payload[key] !== undefined) result[key] = payload[key];
  }
  return result;
};

const withoutSandboxFileFields = (
  details: Record<string, unknown> | null,
): Record<string, unknown> | null => {
  if (!details) return null;
  // `fileChanges` / `producedFiles` are legacy fields written by pre-v2
  // attached-tool daemons; the live protocol no longer carries them, but
  // historical journal rows still do, so keep stripping them from display.
  const {
    filePath: _filePath,
    fileChanges: _fileChanges,
    producedFiles: _producedFiles,
    ...safeDetails
  } = details;
  return safeDetails;
};

const toolResultEvent = (
  record: Extract<JournalRecord, { kind: "message" }>,
): EventRecord => {
  const details = asRecord(record.payload.details);
  const activityDetails = withoutSandboxFileFields(details);
  const resultText = messageText(record.payload);
  const requestId =
    typeof record.payload.toolCallId === "string" && record.payload.toolCallId
      ? record.payload.toolCallId
      : `cloud:${record.turnId}:tool-result:${record.seq}`;
  const toolName =
    typeof record.payload.toolName === "string" && record.payload.toolName
      ? record.payload.toolName
      : "tool";
  return {
    _id: `cloud:${record.turnId}:tool-result:${record.seq}`,
    timestamp: timestampOf(record.payload, record.createdAtMs),
    type: "tool_result",
    requestId,
    payload: {
      ...(activityDetails ?? {}),
      ...copyStructuredActivityFields(record.payload),
      toolName,
      result: activityDetails ?? resultText,
      resultPreview: resultText,
      ...(record.payload.isError === true
        ? { error: resultText || "Tool failed." }
        : {}),
    },
  };
};

/**
 * Projects the canonical Durable Object journal into the legacy event shape
 * consumed by Activity's file attribution and diagnostic trace surfaces.
 * These are read-only view records and are never persisted to desktop SQLite.
 */
export const journalRecordsToCloudActivityEvents = (
  records: readonly JournalRecord[],
): EventRecord[] => {
  const threadIds = agentThreadIdsByTurn(records);
  const events: EventRecord[] = [];
  for (const record of records) {
    if (record.kind === "message" && record.role === "toolResult") {
      events.push(toolResultEvent(record));
      continue;
    }
    if (record.kind !== "card" || record.card.type !== "files") continue;
    const agentId = threadIds.get(record.turnId);
    events.push({
      _id: `cloud:${record.turnId}:files:${record.seq}`,
      timestamp: record.createdAtMs,
      type: "cloud_files",
      payload: {
        cloudDriveFiles: record.card.files,
        ...(agentId ? { agentId } : {}),
      },
    });
  }
  return events;
};

export const journalRecordsToCloudFileEvents = (
  records: readonly JournalRecord[],
): EventRecord[] =>
  journalRecordsToCloudActivityEvents(records).filter(
    (event) => event.type === "cloud_files" && eventContributesFiles(event),
  );

const logicalEventKey = (event: EventRecord): string | null =>
  event.requestId ? `${event.type}\u001f${event.requestId}` : null;

/**
 * SQLite is only a delivery/recovery overlay for cloud conversations. Ten
 * minutes is deliberately much longer than the normal journal append path,
 * while still ensuring a pre-cloud desktop cache cannot become permanent
 * Activity or Files history that browser/mobile never see.
 */
export const LOCAL_CLOUD_EVENT_OVERLAY_TTL_MS = 10 * 60_000;
const LOCAL_CLOUD_EVENT_MAX_FUTURE_SKEW_MS = 60_000;

type LocalCloudEventOverlayOptions = {
  nowMs?: number;
  maxAgeMs?: number;
};

const localEventIsWithinOverlayWindow = (
  event: EventRecord,
  nowMs: number,
  maxAgeMs: number,
): boolean =>
  Number.isFinite(event.timestamp) &&
  event.timestamp <= nowMs + LOCAL_CLOUD_EVENT_MAX_FUTURE_SKEW_MS &&
  event.timestamp + maxAgeMs > nowMs;

/**
 * Returns the next wall-clock instant at which a currently visible local row
 * must retire. The renderer uses this to expire an overlay even when no new
 * SQLite or journal event arrives to trigger another render.
 */
export const nextLocalCloudEventOverlayExpiry = (
  local: readonly EventRecord[],
  nowMs: number,
  maxAgeMs = LOCAL_CLOUD_EVENT_OVERLAY_TTL_MS,
): number | null => {
  let next: number | null = null;
  for (const event of local) {
    if (!localEventIsWithinOverlayWindow(event, nowMs, maxAgeMs)) continue;
    const expiresAt = event.timestamp + maxAgeMs;
    if (next === null || expiresAt < next) next = expiresAt;
  }
  return next;
};

/**
 * Canonical rows replace their matching device-cache event. Local-only rows
 * remain only as a short-lived operational overlay until the journal
 * acknowledgement arrives. Unmatched rows from pre-cloud desktop builds age
 * out instead of becoming a second durable history authority.
 */
export const mergeCanonicalCloudEventsWithLocalOverlay = (
  canonical: readonly EventRecord[],
  local: readonly EventRecord[],
  options: LocalCloudEventOverlayOptions = {},
): EventRecord[] => {
  if (local.length === 0) return [...canonical];
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = Math.max(
    0,
    options.maxAgeMs ?? LOCAL_CLOUD_EVENT_OVERLAY_TTL_MS,
  );
  const canonicalIds = new Set(canonical.map((event) => event._id));
  const canonicalKeys = new Set(
    canonical.map(logicalEventKey).filter((key): key is string => key !== null),
  );
  const merged = local
    .filter((event) => {
      if (canonicalIds.has(event._id)) return false;
      const key = logicalEventKey(event);
      if (key !== null && canonicalKeys.has(key)) return false;
      return localEventIsWithinOverlayWindow(event, nowMs, maxAgeMs);
    })
    .concat(canonical);
  return merged.sort(
    (left, right) =>
      left.timestamp - right.timestamp || left._id.localeCompare(right._id),
  );
};
