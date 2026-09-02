/**
 * Incremental Server-Sent Events parser (WHATWG EventSource framing).
 *
 * Providers disagree on the details — `\r\n` vs `\n`, comment keep-alives
 * (`: ping`), multi-line `data:` payloads, `event:` names, a stray BOM — so
 * the framing rules are implemented in full rather than as a `data:` regex.
 * Bytes are decoded as UTF-8 with a streaming decoder so a multi-byte
 * character split across chunks is never corrupted.
 */

export type SseFrame = {
  event: string | undefined;
  data: string;
  id: string | undefined;
};

export type SseParser = {
  /** Feed a decoded text chunk; returns every frame completed by it. */
  push(text: string): SseFrame[];
  /** Flush the trailing frame that had no terminating blank line. */
  finish(): SseFrame[];
};

export const createSseParser = (): SseParser => {
  let buffer = "";
  let sawBom = false;
  let event: string | undefined;
  let id: string | undefined;
  let dataLines: string[] = [];
  let hasData = false;

  const dispatch = (into: SseFrame[]): void => {
    if (hasData) {
      into.push({ event, data: dataLines.join("\n"), id });
    }
    event = undefined;
    dataLines = [];
    hasData = false;
  };

  const consumeLine = (line: string, into: SseFrame[]): void => {
    if (line === "") {
      dispatch(into);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        dataLines.push(value);
        hasData = true;
        break;
      case "event":
        event = value;
        break;
      case "id":
        if (!value.includes("\0")) id = value;
        break;
      case "retry":
      default:
        // `retry` is a reconnect hint we never act on; unknown fields are
        // ignored per spec.
        break;
    }
  };

  const drain = (into: SseFrame[], flush: boolean): void => {
    if (!sawBom) {
      if (buffer.startsWith("\uFEFF")) buffer = buffer.slice(1);
      if (buffer.length > 0) sawBom = true;
    }
    let start = 0;
    while (start < buffer.length) {
      const cr = buffer.indexOf("\r", start);
      const lf = buffer.indexOf("\n", start);
      let end: number;
      let skip: number;
      if (cr === -1 && lf === -1) break;
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // A trailing CR may be the first half of CRLF split across chunks.
        if (cr === buffer.length - 1 && !flush) break;
        end = cr;
        skip = buffer[cr + 1] === "\n" ? 2 : 1;
      } else {
        end = lf;
        skip = 1;
      }
      consumeLine(buffer.slice(start, end), into);
      start = end + skip;
    }
    buffer = buffer.slice(start);
    if (flush && buffer.length > 0) {
      consumeLine(buffer, into);
      buffer = "";
    }
  };

  return {
    push(text) {
      const frames: SseFrame[] = [];
      buffer += text;
      drain(frames, false);
      return frames;
    },
    finish() {
      const frames: SseFrame[] = [];
      drain(frames, true);
      dispatch(frames);
      return frames;
    },
  };
};

/** `data` parsed as JSON, or null for `[DONE]`, blanks, and non-JSON. */
export const frameJson = (frame: SseFrame): Record<string, unknown> | null => {
  const data = frame.data.trim();
  if (!data || data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const isDoneFrame = (frame: SseFrame): boolean =>
  frame.data.trim() === "[DONE]";
