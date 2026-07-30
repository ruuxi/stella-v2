/**
 * Native client copy of the conversation Durable Object wire contract.
 *
 * Frames with `seq` are durable and replayable. Deltas/tool frames are an
 * advisory live overlay and are replaced by the next committed journal row.
 * Keep this module React- and platform-free so ordering/decoding can be tested.
 */
export const CLOUD_CONVERSATION_PROTOCOL_VERSION = 1;
export const CLOUD_CONVERSATION_INITIAL_WINDOW = 100;
export const CLOUD_CONVERSATION_MAX_RESUME = 2_000;
export const CLOUD_CONVERSATION_BACKFILL_BATCH = 200;
export const CLOUD_CONVERSATION_MAX_BUFFERED_AHEAD = 512;
export const CLOUD_CONVERSATION_MAX_RECORDS = 3_000;
export const CLOUD_CONVERSATION_LIVE_TEXT_LIMIT = 32_000;
export const CLOUD_CONVERSATION_SOCKET_STALE_MS = 90_000;
export const CLOUD_CONVERSATION_REAUTH_LEAD_MS = 60_000;

export type CloudJournalFile = {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  stored?: boolean;
};

export type CloudJournalCard =
  | { type: "build"; buildId: string; appId?: string }
  | {
      type: "operation";
      operation: string;
      args?: Record<string, unknown>;
      result?: Record<string, unknown> | null;
    }
  | { type: "files"; files: CloudJournalFile[] };

type JournalRecordBase = {
  seq: number;
  turnId: string;
  createdAtMs: number;
};

export type CloudJournalMessageRecord = JournalRecordBase & {
  kind: "message";
  role: "user" | "assistant" | "toolResult";
  hidden: boolean;
  streamId?: string;
  clientMsgId?: string;
  payload: Record<string, unknown>;
};

export type CloudJournalTurnRecord = JournalRecordBase & {
  kind: "turn";
  phase: "started" | "completed" | "failed" | "canceled" | "timeout";
  lane?: string;
  source?: string;
  notice?: string;
  wallClockMs?: number;
};

export type CloudJournalCardRecord = JournalRecordBase & {
  kind: "card";
  card: CloudJournalCard;
};

export type CloudJournalRecord =
  | CloudJournalMessageRecord
  | CloudJournalTurnRecord
  | CloudJournalCardRecord;

export type CloudLiveTurn = {
  turnId: string;
  streamId: string;
  partialText: string;
  tools: {
    toolCallId: string;
    name: string;
    label?: string;
    phase: "start" | "end";
    isError?: boolean;
  }[];
};

export type CloudConversationReadyFrame = {
  type: "ready";
  protocol: number;
  conversationId: string;
  epoch: number;
  headSeq: number;
  windowStartSeq: number;
  floorSeq: number;
  title: string;
  activity: string;
  authExpiresAtMs: number;
  serverTimeMs: number;
  live: CloudLiveTurn | null;
};

export type CloudConversationServerFrame =
  | CloudConversationReadyFrame
  | ({ type: "record" } & CloudJournalRecord)
  | {
      type: "backfill";
      requestId: string;
      fromSeq: number;
      toSeq: number;
      complete: boolean;
      records: CloudJournalRecord[];
    }
  | { type: "gap"; fromSeq: number; toSeq: number; reason: string }
  | { type: "reset"; reason: "epoch" | "window" }
  | {
      type: "delta";
      turnId: string;
      streamId: string;
      ordinal: number;
      kind: "text" | "thinking";
      text: string;
    }
  | {
      type: "tool";
      turnId: string;
      toolCallId: string;
      name: string;
      label?: string;
      phase: "start" | "end";
      argsPreview?: string;
      isError?: boolean;
    }
  | { type: "deltas_dropped"; turnId: string; streamId: string }
  | { type: "auth.expiring"; atMs: number }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
      ref?: string;
    };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const decodeCard = (value: unknown): CloudJournalCard | null => {
  const raw = asRecord(value);
  if (!raw) return null;
  if (raw.type === "build" && typeof raw.buildId === "string") {
    return {
      type: "build",
      buildId: raw.buildId,
      ...(typeof raw.appId === "string" ? { appId: raw.appId } : {}),
    };
  }
  if (raw.type === "operation" && typeof raw.operation === "string") {
    return {
      type: "operation",
      operation: raw.operation,
      ...(asRecord(raw.args) ? { args: asRecord(raw.args)! } : {}),
      ...(raw.result === null
        ? { result: null }
        : asRecord(raw.result)
          ? { result: asRecord(raw.result)! }
          : {}),
    };
  }
  if (raw.type === "files" && Array.isArray(raw.files)) {
    const files: CloudJournalFile[] = raw.files.flatMap((value) => {
      const file = asRecord(value);
      const path = text(file?.path);
      if (!file || !path) return [];
      return [
        {
          path,
          name: text(file.name) ?? path.split("/").at(-1) ?? path,
          sizeBytes: number(file.sizeBytes) ?? 0,
          contentType: text(file.contentType) ?? "application/octet-stream",
          ...(file.stored === false ? { stored: false } : {}),
        },
      ];
    });
    return files.length ? { type: "files", files } : null;
  }
  return null;
};

export const decodeCloudJournalRecord = (
  value: unknown,
): CloudJournalRecord | null => {
  const raw = asRecord(value);
  const seq = number(raw?.seq);
  const turnId = text(raw?.turnId);
  if (!raw || seq === undefined || !turnId) return null;
  const createdAtMs = number(raw.createdAtMs) ?? 0;
  if (raw.kind === "message") {
    const payload = asRecord(raw.payload);
    const role = raw.role;
    if (
      !payload ||
      (role !== "user" && role !== "assistant" && role !== "toolResult")
    ) {
      return null;
    }
    return {
      kind: "message",
      seq,
      turnId,
      createdAtMs,
      role,
      hidden: raw.hidden === true,
      ...(text(raw.streamId) ? { streamId: text(raw.streamId)! } : {}),
      ...(text(raw.clientMsgId) ? { clientMsgId: text(raw.clientMsgId)! } : {}),
      payload,
    };
  }
  if (raw.kind === "turn") {
    const phase = raw.phase;
    if (
      phase !== "started" &&
      phase !== "completed" &&
      phase !== "failed" &&
      phase !== "canceled" &&
      phase !== "timeout"
    ) {
      return null;
    }
    return {
      kind: "turn",
      seq,
      turnId,
      createdAtMs,
      phase,
      ...(text(raw.lane) ? { lane: text(raw.lane)! } : {}),
      ...(text(raw.source) ? { source: text(raw.source)! } : {}),
      ...(text(raw.notice) ? { notice: text(raw.notice)! } : {}),
      ...(number(raw.wallClockMs) !== undefined
        ? { wallClockMs: number(raw.wallClockMs)! }
        : {}),
    };
  }
  if (raw.kind === "card") {
    const card = decodeCard(raw.card);
    return card ? { kind: "card", seq, turnId, createdAtMs, card } : null;
  }
  return null;
};

const decodeLive = (value: unknown): CloudLiveTurn | null => {
  const raw = asRecord(value);
  const turnId = text(raw?.turnId);
  if (!raw || !turnId) return null;
  const tools: CloudLiveTurn["tools"] = [];
  if (Array.isArray(raw.tools)) {
    for (const value of raw.tools) {
      const tool = asRecord(value);
      const toolCallId = text(tool?.toolCallId);
      const name = text(tool?.name);
      if (!tool || !toolCallId || !name) continue;
      tools.push({
        toolCallId,
        name,
        ...(text(tool.label) ? { label: text(tool.label)! } : {}),
        phase: tool.phase === "end" ? "end" : "start",
        ...(tool.isError === true ? { isError: true } : {}),
      });
    }
  }
  return {
    turnId,
    streamId: text(raw.streamId) ?? `live:${turnId}`,
    partialText: (text(raw.partialText) ?? "").slice(
      0,
      CLOUD_CONVERSATION_LIVE_TEXT_LIMIT,
    ),
    tools,
  };
};

export const decodeCloudConversationFrame = (
  data: string,
): CloudConversationServerFrame | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const raw = asRecord(parsed);
  if (!raw) return null;
  if (raw.type === "ready") {
    const conversationId = text(raw.conversationId);
    if (!conversationId) return null;
    return {
      type: "ready",
      protocol: number(raw.protocol) ?? CLOUD_CONVERSATION_PROTOCOL_VERSION,
      conversationId,
      epoch: number(raw.epoch) ?? 0,
      headSeq: number(raw.headSeq) ?? -1,
      windowStartSeq: number(raw.windowStartSeq) ?? 0,
      floorSeq: number(raw.floorSeq) ?? 0,
      title: text(raw.title) ?? "",
      activity: text(raw.activity) ?? "idle",
      authExpiresAtMs: number(raw.authExpiresAtMs) ?? 0,
      serverTimeMs: number(raw.serverTimeMs) ?? Date.now(),
      live: decodeLive(raw.live),
    };
  }
  if (raw.type === "record") {
    const record = decodeCloudJournalRecord(raw);
    return record ? { type: "record", ...record } : null;
  }
  if (raw.type === "backfill" && typeof raw.requestId === "string") {
    return {
      type: "backfill",
      requestId: raw.requestId,
      fromSeq: number(raw.fromSeq) ?? 0,
      toSeq: number(raw.toSeq) ?? 0,
      complete: raw.complete !== false,
      records: Array.isArray(raw.records)
        ? raw.records.flatMap((value) => {
            const record = decodeCloudJournalRecord(value);
            return record ? [record] : [];
          })
        : [],
    };
  }
  if (raw.type === "gap") {
    return {
      type: "gap",
      fromSeq: number(raw.fromSeq) ?? 0,
      toSeq: number(raw.toSeq) ?? 0,
      reason: text(raw.reason) ?? "compacted",
    };
  }
  if (raw.type === "reset") {
    return { type: "reset", reason: raw.reason === "epoch" ? "epoch" : "window" };
  }
  if (raw.type === "delta") {
    const turnId = text(raw.turnId);
    const streamId = text(raw.streamId);
    const value = text(raw.text);
    if (!turnId || !streamId || value === undefined) return null;
    return {
      type: "delta",
      turnId,
      streamId,
      ordinal: number(raw.ordinal) ?? 0,
      kind: raw.kind === "thinking" ? "thinking" : "text",
      text: value,
    };
  }
  if (raw.type === "tool") {
    const turnId = text(raw.turnId);
    const toolCallId = text(raw.toolCallId);
    const name = text(raw.name);
    if (!turnId || !toolCallId || !name) return null;
    return {
      type: "tool",
      turnId,
      toolCallId,
      name,
      ...(text(raw.label) ? { label: text(raw.label)! } : {}),
      phase: raw.phase === "end" ? "end" : "start",
      ...(text(raw.argsPreview)
        ? { argsPreview: text(raw.argsPreview)! }
        : {}),
      ...(raw.isError === true ? { isError: true } : {}),
    };
  }
  if (raw.type === "deltas_dropped") {
    const turnId = text(raw.turnId);
    const streamId = text(raw.streamId);
    return turnId && streamId
      ? { type: "deltas_dropped", turnId, streamId }
      : null;
  }
  if (raw.type === "auth.expiring") {
    return { type: "auth.expiring", atMs: number(raw.atMs) ?? 0 };
  }
  if (raw.type === "error") {
    return {
      type: "error",
      code: text(raw.code) ?? "unknown",
      message: text(raw.message) ?? "Something went wrong.",
      retryable: raw.retryable !== false,
      ...(text(raw.ref) ? { ref: text(raw.ref)! } : {}),
    };
  }
  return null;
};

export const cloudJournalMessageText = (
  payload: Record<string, unknown>,
): string => {
  if (typeof payload.content === "string") return payload.content.trim();
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .flatMap((value) => {
      const block = asRecord(value);
      return block?.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [];
    })
    .join("\n")
    .trim();
};

const SUBPROTOCOL_TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
export const isCloudConversationTokenSubprotocolSafe = (token: string) =>
  Boolean(token) && SUBPROTOCOL_TOKEN.test(token);
