/**
 * The offline chat's client-side tool protocol.
 *
 * The offline responder is a plain streaming-text model with no native
 * tool-call channel, so tools are bolted on through the one thing the client
 * controls: the prompt and the streamed text. Each turn the client injects a
 * preamble that (a) carries the user's durable memory + the rolling compaction
 * summary as context and (b) documents four tools and the exact text syntax to
 * invoke them. The model emits tool calls as a trailing, delimited block; the
 * client parses that block, hides it from the rendered reply, and runs the
 * tools on-device (persist a memory fact, resolve a map card, search earlier
 * messages).
 *
 * This is the mobile analog of the desktop's Remember / Recall / map tools,
 * collapsed onto a text protocol because there is no runtime tool loop here.
 */

import { formatMemoryForContext, type MemoryFact } from "./chat-memory";

export const TOOL_BLOCK_OPEN = "<<<STELLA_TOOLS";
export const TOOL_BLOCK_CLOSE = "STELLA_TOOLS>>>";

export type ToolCall =
  | { tool: "remember"; key: string; value: string }
  | { tool: "forget"; key: string }
  | { tool: "recall"; query: string }
  | {
      tool: "map";
      places?: string[];
      origin?: string;
      destination?: string;
      mode?: string;
      title?: string;
    };

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(asString).filter((entry) => entry.length > 0)
    : [];

const toToolCall = (value: unknown): ToolCall | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  switch (record.tool) {
    case "remember": {
      const key = asString(record.key);
      const val = asString(record.value);
      return key && val ? { tool: "remember", key, value: val } : null;
    }
    case "forget": {
      const key = asString(record.key);
      return key ? { tool: "forget", key } : null;
    }
    case "recall": {
      const query = asString(record.query);
      return query ? { tool: "recall", query } : null;
    }
    case "map": {
      const places = asStringArray(record.places);
      const origin = asString(record.origin);
      const destination = asString(record.destination);
      if (places.length === 0 && !(origin && destination)) return null;
      return {
        tool: "map",
        ...(places.length > 0 ? { places } : {}),
        ...(origin ? { origin } : {}),
        ...(destination ? { destination } : {}),
        ...(asString(record.mode) ? { mode: asString(record.mode) } : {}),
        ...(asString(record.title) ? { title: asString(record.title) } : {}),
      };
    }
    default:
      return null;
  }
};

export type ParsedReply = {
  /** The reply with the tool block stripped, ready to render. */
  visibleText: string;
  /** Parsed, validated tool calls (in the order the model emitted them). */
  calls: ToolCall[];
};

/** Split a completed reply into its visible prose and its tool calls. */
export function parseToolBlock(rawText: string): ParsedReply {
  const openAt = rawText.indexOf(TOOL_BLOCK_OPEN);
  if (openAt === -1) {
    return { visibleText: rawText.trim(), calls: [] };
  }
  const visibleText = rawText.slice(0, openAt).trim();
  const afterOpen = rawText.slice(openAt + TOOL_BLOCK_OPEN.length);
  const closeAt = afterOpen.indexOf(TOOL_BLOCK_CLOSE);
  const body = closeAt === -1 ? afterOpen : afterOpen.slice(0, closeAt);

  const calls: ToolCall[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("[")))
      continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      const call = toToolCall(entry);
      if (call) calls.push(call);
    }
  }
  return { visibleText, calls };
}

/**
 * Streaming filter that hides the trailing tool block while text streams in.
 * `feed` returns only the newly-safe VISIBLE characters for each delta; once
 * the open marker appears, nothing further is emitted. `finalize` flushes any
 * held-back visible tail, and `raw` returns the full accumulated text for
 * `parseToolBlock`.
 */
export function createToolBlockFilter() {
  let raw = "";
  let emitted = 0;
  let sawOpen = false;
  const holdBack = TOOL_BLOCK_OPEN.length - 1;

  return {
    feed(delta: string): string {
      raw += delta;
      if (sawOpen) return "";
      const openAt = raw.indexOf(TOOL_BLOCK_OPEN);
      if (openAt !== -1) {
        sawOpen = true;
        const slice = raw.slice(emitted, openAt);
        emitted = openAt;
        return slice;
      }
      // Hold back the tail that could still become the open marker.
      const safeEnd = Math.max(emitted, raw.length - holdBack);
      if (safeEnd <= emitted) return "";
      const slice = raw.slice(emitted, safeEnd);
      emitted = safeEnd;
      return slice;
    },
    finalize(): string {
      if (sawOpen) return "";
      const openAt = raw.indexOf(TOOL_BLOCK_OPEN);
      const end = openAt === -1 ? raw.length : openAt;
      if (end <= emitted) return "";
      const slice = raw.slice(emitted, end);
      emitted = end;
      return slice;
    },
    raw(): string {
      return raw;
    },
  };
}

const TOOL_INSTRUCTIONS = [
  "You have four on-device tools, invoked through a text protocol.",
  "To use them, append EXACTLY ONE tool block at the very END of your reply with nothing after it:",
  TOOL_BLOCK_OPEN,
  '{"tool":"remember","key":"home city","value":"Austin, TX"}',
  TOOL_BLOCK_CLOSE,
  "Put one compact JSON object per line inside the block. The block is invisible to the user - never mention it or put tool JSON anywhere else. Only include a block when you actually use a tool.",
  "Tools:",
  '- remember: store a durable fact about the user you will want in future sessions (name, location, stable preference, ongoing situation). {"tool":"remember","key":"...","value":"..."}',
  '- forget: remove a stored fact. {"tool":"forget","key":"..."}',
  '- map: show an interactive map card inline (pins and/or a route). {"tool":"map","places":["Blue Bottle, SF"]} or {"tool":"map","origin":"...","destination":"...","mode":"driving"}',
  '- recall: full-text search YOUR earlier messages in this conversation. {"tool":"recall","query":"..."} When you need to recall, reply with ONLY the tool block (no answer text) and wait for the results, then answer.',
].join("\n");

/**
 * Build the per-turn context preamble: durable memory + rolling compaction
 * summary + tool instructions. Sent as a leading context turn so the model
 * both "remembers" the user and knows how to reach the tools.
 */
export function buildToolPreamble(args: {
  memoryFacts: MemoryFact[];
  summary: string;
}): string {
  const sections: string[] = [];
  const memory = formatMemoryForContext(args.memoryFacts);
  if (memory) sections.push(memory);
  if (args.summary.trim()) {
    sections.push(
      `Summary of earlier conversation (older turns were compacted to save space):\n${args.summary.trim()}`,
    );
  }
  sections.push(TOOL_INSTRUCTIONS);
  return sections.join("\n\n");
}
