import { frameJson, type SseFrame } from "./sse.js";
import {
  asRecord,
  asString,
  type Assembler,
  type AssembleOutcome,
} from "./types.js";

/**
 * Anthropic Messages stream -> `Message`.
 *
 *   message_start          the skeleton (`message` with empty `content`)
 *   content_block_start    appends `content_block` at `index`
 *   content_block_delta    text_delta / thinking_delta / signature_delta /
 *                          input_json_delta / citations_delta
 *   content_block_stop     finalizes accumulated tool input JSON
 *   message_delta          merges `delta` (stop_reason, stop_sequence, …)
 *                          and `usage` into the message
 *   message_stop           terminal
 *   error                  provider-side failure mid-stream
 */
export const createAnthropicAssembler = (): Assembler => {
  let message: Record<string, unknown> | null = null;
  const blocks: Record<string, unknown>[] = [];
  const partialJson = new Map<number, string>();
  let stopped = false;
  let error: unknown;

  const finalizeInput = (index: number): void => {
    if (!partialJson.has(index)) return;
    const raw = partialJson.get(index) ?? "";
    partialJson.delete(index);
    const block = blocks[index];
    if (!block) return;
    const trimmed = raw.trim();
    if (!trimmed) {
      block.input = {};
      return;
    }
    try {
      block.input = JSON.parse(trimmed) as unknown;
    } catch {
      error = {
        type: "error",
        error: {
          type: "api_error",
          message: `Tool input at content index ${index} was not valid JSON.`,
        },
      };
    }
  };

  const push = (frame: SseFrame): void => {
    if (stopped || error !== undefined) return;
    const event = frameJson(frame);
    if (!event) return;
    const type = asString(event.type) ?? frame.event;
    switch (type) {
      case "message_start": {
        const skeleton = asRecord(event.message);
        if (!skeleton) break;
        message = { ...skeleton, type: "message", content: blocks };
        break;
      }
      case "content_block_start": {
        const index =
          typeof event.index === "number" ? event.index : blocks.length;
        const block = asRecord(event.content_block);
        if (!block) break;
        const copy: Record<string, unknown> = { ...block };
        if (
          typeof copy.input === "object" &&
          copy.input !== null &&
          !Array.isArray(copy.input)
        ) {
          copy.input = { ...(copy.input as Record<string, unknown>) };
        }
        blocks[index] = copy;
        if ("input" in copy) partialJson.set(index, "");
        break;
      }
      case "content_block_delta": {
        const index = typeof event.index === "number" ? event.index : -1;
        const block = blocks[index];
        const delta = asRecord(event.delta);
        if (!block || !delta) break;
        switch (delta.type) {
          case "text_delta":
            block.text =
              (asString(block.text) ?? "") + (asString(delta.text) ?? "");
            break;
          case "thinking_delta":
            block.thinking =
              (asString(block.thinking) ?? "") +
              (asString(delta.thinking) ?? "");
            break;
          case "signature_delta":
            if (typeof delta.signature === "string")
              block.signature = delta.signature;
            break;
          case "input_json_delta":
            partialJson.set(
              index,
              (partialJson.get(index) ?? "") +
                (asString(delta.partial_json) ?? ""),
            );
            break;
          case "citations_delta": {
            const citations = Array.isArray(block.citations)
              ? block.citations
              : [];
            if (delta.citation !== undefined) citations.push(delta.citation);
            block.citations = citations;
            break;
          }
          default:
            break;
        }
        break;
      }
      case "content_block_stop": {
        const index = typeof event.index === "number" ? event.index : -1;
        finalizeInput(index);
        break;
      }
      case "message_delta": {
        if (!message) break;
        const delta = asRecord(event.delta);
        if (delta) {
          for (const [key, value] of Object.entries(delta)) {
            if (value !== undefined) message[key] = value;
          }
        }
        const usage = asRecord(event.usage);
        if (usage) {
          const merged = { ...(asRecord(message.usage) ?? {}) };
          for (const [key, value] of Object.entries(usage)) {
            if (value !== undefined && value !== null) merged[key] = value;
          }
          message.usage = merged;
        }
        break;
      }
      case "message_stop":
        stopped = true;
        break;
      case "error":
        error = event;
        break;
      case "ping":
      default:
        break;
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
          "The model provider reported a streaming error.",
        detail: error,
      };
    }
    if (!message) {
      return {
        ok: false,
        message: "The model provider stream ended before message_start.",
      };
    }
    if (!stopped) {
      return {
        ok: false,
        message: "The model provider stream ended before message_stop.",
      };
    }
    for (const index of Array.from(partialJson.keys())) finalizeInput(index);
    if (error !== undefined) {
      return {
        ok: false,
        message: "Tool input in the model stream was not valid JSON.",
        detail: error,
      };
    }
    // Sparse indexes (a skipped content_block_start) must not surface as holes.
    message.content = blocks.filter((block) => block !== undefined);
    return { ok: true, body: message };
  };

  return { push, finish };
};
