/**
 * Relay-owned OpenAI Responses resume protocol.
 *
 * Retention model:
 * - Provider requests remain `store: false`; prompts and request/tool schemas
 *   are never written here.
 * - Only downstream SSE response events needed for cursor replay are retained.
 * - Streams expire as a unit after 10 minutes and are capped at 4 MiB or 8,192
 *   events, whichever comes first. A capped stream fails closed for resume.
 */

export const STELLA_RELAY_RESUME_VERSION = "1";
export const STELLA_RELAY_RESUME_HEADER = "x-stella-relay-resume";
export const STELLA_RELAY_REQUEST_ID_HEADER = "x-stella-relay-request-id";
export const STELLA_RELAY_RESUME_TTL_MS = 10 * 60 * 1000;
export const STELLA_RELAY_RESUME_STALE_MS = 30 * 1000;
export const STELLA_RELAY_RESUME_MAX_BYTES = 4 * 1024 * 1024;
export const STELLA_RELAY_RESUME_MAX_EVENTS = 8_192;
export const STELLA_RELAY_RESUME_MAX_EVENT_BYTES = 256 * 1024;
export const STELLA_RELAY_RESUME_CHUNK_MAX_BYTES = 128 * 1024;
export const STELLA_RELAY_RESUME_CHUNK_MAX_EVENTS = 128;
export const STELLA_RELAY_RESUME_POLL_MS = 100;

export type RelayResumeStatus =
  | "streaming"
  | "completed"
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
  terminalStatus?: "completed" | "failed" | "error";
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
    case "response.failed":
      return "failed";
    case "error":
      return "error";
    default:
      return undefined;
  }
};

const splitFrame = (buffer: string): { frame: string; rest: string } | null => {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) {
    return {
      frame: buffer.slice(0, crlf + 4),
      rest: buffer.slice(crlf + 4),
    };
  }
  return {
    frame: buffer.slice(0, lf + 2),
    rest: buffer.slice(lf + 2),
  };
};

const dataFromFrame = (frame: string): string | null => {
  const values = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /u, ""));
  return values.length > 0 ? values.join("\n") : null;
};

export class RelayResumeSseParser {
  private buffer = "";
  private nextSequence = 1;

  push(text: string): RelayResumeFrame[] {
    this.buffer += text;
    const frames: RelayResumeFrame[] = [];
    while (true) {
      const split = splitFrame(this.buffer);
      if (!split) break;
      this.buffer = split.rest;
      frames.push(this.parseFrame(split.frame));
    }
    return frames;
  }

  finish(): string {
    const remainder = this.buffer;
    this.buffer = "";
    return remainder;
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
    const rewritten = {
      ...record,
      stella_relay_sequence: sequence,
    };
    return {
      kind: "event",
      event: {
        sequence,
        frame: `data: ${JSON.stringify(rewritten)}\n\n`,
        eventType,
        ...(responseId ? { responseId } : {}),
        ...(responseStatus ? { responseStatus } : {}),
        ...(terminalStatusForEvent(eventType)
          ? { terminalStatus: terminalStatusForEvent(eventType) }
          : {}),
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
  if (args.snapshot.expiresAt <= args.nowMs) {
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

export const relayResumeTerminalSuffix = (
  status: RelayResumeStatus,
  lastSequence: number,
): string[] | null => {
  if (status === "completed" || status === "failed" || status === "error") {
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
