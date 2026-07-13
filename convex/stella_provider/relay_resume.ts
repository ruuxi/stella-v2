/**
 * Relay-owned OpenAI Responses resume protocol.
 *
 * Provider requests remain `store: false`. The transient buffer may contain
 * plaintext response text, reasoning, and tool arguments because the relay
 * must continue receiving the upstream stream after a client disconnects.
 * It never stores request bodies, prompts, input messages, tool definitions,
 * credentials, or request headers.
 */

export const STELLA_RELAY_RESUME_VERSION = "1";
export const STELLA_RELAY_RESUME_HEADER = "x-stella-relay-resume";
export const STELLA_RELAY_REQUEST_ID_HEADER = "x-stella-relay-request-id";

// Logical access expires two minutes after the latest live activity, with a
// hard ten-minute lifetime even if an upstream never terminates. Ten minutes
// matches the Convex HTTP-action lifetime that bounds the relay action which
// produces events, so the advertised resume window never promises more than
// the platform can actually serve.
export const STELLA_RELAY_RESUME_TTL_MS = 2 * 60 * 1000;
export const STELLA_RELAY_RESUME_HARD_TTL_MS = 10 * 60 * 1000;
export const STELLA_RELAY_RESUME_STALE_MS = 30 * 1000;

export const STELLA_RELAY_RESUME_MAX_BYTES = 1024 * 1024;
export const STELLA_RELAY_RESUME_MAX_EVENTS = 4_096;
export const STELLA_RELAY_RESUME_MAX_EVENT_BYTES = 128 * 1024;
export const STELLA_RELAY_RESUME_RAW_FRAME_MAX_BYTES = 256 * 1024;
export const STELLA_RELAY_RESUME_CHUNK_MAX_BYTES = 64 * 1024;
export const STELLA_RELAY_RESUME_CHUNK_MAX_EVENTS = 64;
export const STELLA_RELAY_RESUME_QUERY_MAX_CHUNKS = 2;

export const STELLA_RELAY_RESUME_POLL_MIN_MS = 100;
export const STELLA_RELAY_RESUME_POLL_MAX_MS = 1_000;
export const STELLA_RELAY_RESUME_LEASE_TTL_MS = 15_000;
// Consumers must revalidate their lease at least this often; a consumer that
// stops refreshing loses delivery instead of lingering outside the caps.
export const STELLA_RELAY_RESUME_LEASE_REFRESH_MS = 5_000;
export const STELLA_RELAY_CANCEL_INTENT_TTL_MS = 2 * 60 * 1000;
export const STELLA_RELAY_RESUME_MAX_STREAM_LEASES = 2;
export const STELLA_RELAY_RESUME_MAX_OWNER_LEASES = 8;
export const STELLA_RELAY_RESUME_RATE_PER_OWNER = 30;
export const STELLA_RELAY_RESUME_RATE_PER_STREAM = 10;
export const STELLA_RELAY_CANCEL_RATE_PER_OWNER = 30;
export const STELLA_RELAY_RESUME_RATE_WINDOW_MS = 60_000;

export const STELLA_RELAY_RESUME_MAX_OWNER_STREAMS = 8;
export const STELLA_RELAY_RESUME_MAX_OWNER_BYTES = 4 * 1024 * 1024;
export const STELLA_RELAY_RESUME_MAX_GLOBAL_STREAMS = 2_048;
export const STELLA_RELAY_RESUME_MAX_GLOBAL_BYTES = 256 * 1024 * 1024;
// Cancellation tombstones are tiny but must not become an unmetered write
// channel: they are quota-bounded per owner and service-wide.
export const STELLA_RELAY_RESUME_MAX_OWNER_INTENTS = 32;
export const STELLA_RELAY_RESUME_MAX_GLOBAL_INTENTS = 4_096;

export const STELLA_RELAY_OWNER_PURGE_TTL_MS = 24 * 60 * 60 * 1000;

export const STELLA_RELAY_CLEANUP_MAX_DOCS = 16;
export const STELLA_RELAY_CLEANUP_MAX_BYTES = 256 * 1024;
export const STELLA_RELAY_CLEANUP_MAX_BATCHES = 20;
// Fair per-class sweep budgets: tombstones and leases can never starve
// stream/chunk deletion, which always keeps the remaining document budget.
export const STELLA_RELAY_CLEANUP_MAX_INTENT_DOCS = 4;
export const STELLA_RELAY_CLEANUP_MAX_LEASE_DOCS = 4;
export const STELLA_RELAY_CLEANUP_MAX_PURGE_DOCS = 2;

export type RelayResumeStatus =
  | "streaming"
  | "completed"
  | "incomplete"
  | "failed"
  | "error"
  | "canceled"
  | "upstream_eof"
  | "truncated";

export type RelayResumeEvent = {
  sequence: number;
  frame: string;
  eventType: string;
  responseId?: string;
  responseStatus?: string;
  terminalStatus?: "completed" | "incomplete" | "failed" | "error";
};

export type RelayResumeFrame =
  | { kind: "event"; event: RelayResumeEvent }
  | { kind: "passthrough"; frame: string; replaySafe: boolean }
  | { kind: "done"; frame: string };

const encoder = new TextEncoder();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringField = (
  record: Record<string, unknown> | null,
  key: string,
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const terminalStatusForEvent = (
  eventType: string,
): RelayResumeEvent["terminalStatus"] => {
  switch (eventType) {
    case "response.completed":
      return "completed";
    case "response.incomplete":
      return "incomplete";
    case "response.failed":
      return "failed";
    case "error":
      return "error";
    default:
      return undefined;
  }
};

const lineEndingLength = (
  value: string,
  index: number,
  final: boolean,
): number => {
  const char = value[index];
  if (char === "\n") return 1;
  if (char !== "\r") return 0;
  if (value[index + 1] === "\n") return 2;
  return index + 1 < value.length || final ? 1 : 0;
};

const findEventBoundary = (value: string, final: boolean): number | null => {
  for (let index = 0; index < value.length; index += 1) {
    const first = lineEndingLength(value, index, final);
    if (first === 0) continue;
    const secondStart = index + first;
    const second = lineEndingLength(value, secondStart, final);
    if (second > 0) return secondStart + second;
    index = secondStart - 1;
  }
  return null;
};

const dataFromFrame = (frame: string): string | null => {
  const values: string[] = [];
  for (const line of frame.split(/\r\n|\r|\n/u)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") values.push(value);
  }
  return values.length > 0 ? values.join("\n") : null;
};

export class RelayResumeFrameTooLargeError extends Error {
  constructor() {
    super("Upstream SSE frame exceeded the Stella relay pending-frame limit");
    this.name = "RelayResumeFrameTooLargeError";
  }
}

export class RelayResumeSseParser {
  private buffer = "";
  private nextSequence = 1;
  private bomPending = true;

  push(text: string): RelayResumeFrame[] {
    const frames: RelayResumeFrame[] = [];
    // Process large transport chunks incrementally so the raw pending frame is
    // bounded even when fetch hands us a multi-megabyte Uint8Array.
    for (let offset = 0; offset < text.length; offset += 16 * 1024) {
      this.buffer += text.slice(offset, offset + 16 * 1024);
      // The SSE grammar allows exactly one leading U+FEFF before the first
      // field; strip it once even when the byte-level decoder was configured
      // to preserve it or the mark arrived split across transport chunks.
      if (this.bomPending && this.buffer.length > 0) {
        this.bomPending = false;
        if (this.buffer[0] === "\uFEFF") this.buffer = this.buffer.slice(1);
      }
      frames.push(...this.extractFrames(false));
      if (
        encoder.encode(this.buffer).byteLength >
        STELLA_RELAY_RESUME_RAW_FRAME_MAX_BYTES
      ) {
        throw new RelayResumeFrameTooLargeError();
      }
    }
    return frames;
  }

  finish(): { frames: RelayResumeFrame[]; remainder: string } {
    const frames = this.extractFrames(true);
    if (this.buffer.length > 0) {
      frames.push(this.parseFrame(this.buffer));
      this.buffer = "";
    }
    return { frames, remainder: "" };
  }

  pendingBytes(): number {
    return encoder.encode(this.buffer).byteLength;
  }

  private extractFrames(final: boolean): RelayResumeFrame[] {
    const frames: RelayResumeFrame[] = [];
    while (true) {
      const boundary = findEventBoundary(this.buffer, final);
      if (boundary === null) break;
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary);
      frames.push(this.parseFrame(frame));
    }
    return frames;
  }

  private parseFrame(frame: string): RelayResumeFrame {
    const data = dataFromFrame(frame);
    if (data === null) {
      return { kind: "passthrough", frame, replaySafe: true };
    }
    if (data.trim() === "[DONE]") return { kind: "done", frame };

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return { kind: "passthrough", frame, replaySafe: false };
    }
    const record = asRecord(parsed);
    const eventType = stringField(record, "type");
    if (!record || !eventType) {
      return { kind: "passthrough", frame, replaySafe: false };
    }

    const sequence = this.nextSequence++;
    const response = asRecord(record.response);
    const responseId = stringField(response, "id");
    const responseStatus = stringField(response, "status");
    const terminalStatus = terminalStatusForEvent(eventType);
    return {
      kind: "event",
      event: {
        sequence,
        frame: `data: ${JSON.stringify({
          ...record,
          stella_relay_sequence: sequence,
        })}\n\n`,
        eventType,
        ...(responseId ? { responseId } : {}),
        ...(responseStatus ? { responseStatus } : {}),
        ...(terminalStatus ? { terminalStatus } : {}),
      },
    };
  }
}

export const relayResumeEventBytes = (event: RelayResumeEvent): number =>
  encoder.encode(event.frame).byteLength;

export const relayResumeSyntheticErrorFrame = (args: {
  sequence: number;
  code:
    | "relay_stream_lost"
    | "relay_buffer_truncated"
    | "relay_stream_canceled";
  message: string;
}): string =>
  `data: ${JSON.stringify({
    type: "error",
    sequence_number: args.sequence,
    stella_relay_sequence: args.sequence,
    code: args.code,
    message: args.message,
  })}\n\n`;

export const relayResumeChunkEvents = (
  events: RelayResumeEvent[],
): RelayResumeEvent[][] => {
  const chunks: RelayResumeEvent[][] = [];
  let current: RelayResumeEvent[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const bytes = relayResumeEventBytes(event);
    if (
      current.length > 0 &&
      (current.length >= STELLA_RELAY_RESUME_CHUNK_MAX_EVENTS ||
        currentBytes + bytes > STELLA_RELAY_RESUME_CHUNK_MAX_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

export type RelayResumeAccessSnapshot = {
  ownerId: string;
  expiresAt: number;
  hardExpiresAt: number;
  lastSequence: number;
};

export type RelayResumeAccessDecision =
  | { ok: true }
  | { ok: false; status: 404 | 410 | 416; message: string };

export const decideRelayResumeAccess = (args: {
  ownerId: string;
  snapshot: RelayResumeAccessSnapshot | null;
  startingAfter: number;
  nowMs: number;
}): RelayResumeAccessDecision => {
  if (!args.snapshot || args.snapshot.ownerId !== args.ownerId) {
    return { ok: false, status: 404, message: "Relay response not found" };
  }
  if (
    args.snapshot.expiresAt <= args.nowMs ||
    args.snapshot.hardExpiresAt <= args.nowMs
  ) {
    return { ok: false, status: 410, message: "Relay resume cursor expired" };
  }
  if (args.startingAfter > args.snapshot.lastSequence) {
    return {
      ok: false,
      status: 416,
      message: "Relay resume cursor is ahead of the stream",
    };
  }
  return { ok: true };
};

export const relayResumeStreamIsStale = (
  updatedAt: number,
  nowMs: number,
): boolean => nowMs - updatedAt > STELLA_RELAY_RESUME_STALE_MS;

export const relayResumeNextPollDelay = (
  currentMs: number,
  deliveredEvents: boolean,
): number =>
  deliveredEvents
    ? STELLA_RELAY_RESUME_POLL_MIN_MS
    : Math.min(
        STELLA_RELAY_RESUME_POLL_MAX_MS,
        Math.max(STELLA_RELAY_RESUME_POLL_MIN_MS, currentMs * 2),
      );

export const relayResumeTerminalSuffix = (
  status: RelayResumeStatus,
  lastSequence: number,
): string[] | null => {
  if (
    status === "completed" ||
    status === "incomplete" ||
    status === "failed" ||
    status === "error"
  ) {
    return ["data: [DONE]\n\n"];
  }
  if (status === "upstream_eof" || status === "truncated") {
    return [
      relayResumeSyntheticErrorFrame({
        sequence: lastSequence + 1,
        code:
          status === "truncated"
            ? "relay_buffer_truncated"
            : "relay_stream_lost",
        message:
          status === "truncated"
            ? "The bounded Stella relay resume buffer was exceeded. The original request was not replayed."
            : "The Stella relay lost its upstream response before a terminal event. The original request was not replayed.",
      }),
      "data: [DONE]\n\n",
    ];
  }
  if (status === "canceled") {
    return [
      relayResumeSyntheticErrorFrame({
        sequence: lastSequence + 1,
        code: "relay_stream_canceled",
        message: "The Stella relay response was canceled.",
      }),
      "data: [DONE]\n\n",
    ];
  }
  return null;
};

export const isValidRelayRequestId = (value: string | null): value is string =>
  typeof value === "string" &&
  value.length >= 16 &&
  value.length <= 100 &&
  /^[A-Za-z0-9_-]+$/u.test(value);

/**
 * Older Stella clients already reuse one opaque Idempotency-Key for every
 * reconnect attempt belonging to a logical Responses request. Hash that key
 * with the authenticated owner to obtain a stable, non-revealing relay id, so
 * a replayed POST resolves to the existing durable stream instead of starting
 * another upstream execution.
 */
export const relayRequestIdFromIdempotencyKey = async (
  ownerId: string,
  idempotencyKey: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`stella-relay-v1\0${ownerId}\0${idempotencyKey}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `stella-relay-${hex}`;
};
