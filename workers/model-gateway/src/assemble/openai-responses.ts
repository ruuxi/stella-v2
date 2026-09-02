import { frameJson, type SseFrame } from "./sse.js";
import {
  asRecord,
  asString,
  type Assembler,
  type AssembleOutcome,
} from "./types.js";

/**
 * OpenAI Responses stream -> `Response`.
 *
 * The Responses API is self-assembling: the terminal event
 * (`response.completed` | `response.failed` | `response.incomplete`) carries
 * the complete `response` object, so nothing is folded from deltas. A stream
 * that ends without a terminal event, or that carries an `error` event, is a
 * failure — the partial output items are never returned as a result.
 */
const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

export const createOpenAIResponsesAssembler = (): Assembler => {
  let terminal: Record<string, unknown> | null = null;
  let error: unknown;

  const push = (frame: SseFrame): void => {
    if (terminal || error !== undefined) return;
    const event = frameJson(frame);
    if (!event) return;
    const type = asString(event.type) ?? frame.event;
    if (type === "error") {
      error = event;
      return;
    }
    if (type && TERMINAL_EVENTS.has(type)) {
      const response = asRecord(event.response);
      if (response) terminal = response;
      return;
    }
    // Some gateways emit a bare `{"error": {...}}` frame with no `type`.
    if (event.error && typeof event.error === "object" && !type) {
      error = event;
    }
  };

  const finish = (): AssembleOutcome => {
    if (error !== undefined) {
      const detail = asRecord(error);
      const inner = asRecord(detail?.error);
      return {
        ok: false,
        message:
          asString(inner?.message) ??
          asString(detail?.message) ??
          "The model provider reported a streaming error.",
        detail: error,
      };
    }
    if (!terminal) {
      return {
        ok: false,
        message:
          "The model provider stream ended without a terminal response event.",
      };
    }
    return { ok: true, body: terminal };
  };

  return { push, finish };
};
