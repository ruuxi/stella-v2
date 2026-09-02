import type { SseFrame } from "./sse.js";

/**
 * A protocol assembler folds a provider's streaming events back into the
 * single JSON object the provider would have returned non-streaming. The
 * gateway streams upstream purely so long completions survive proxy idle
 * limits; callers only ever see the assembled object.
 */
export type AssembleOutcome =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false;
      /** Caller-safe message. */
      message: string;
      /** Provider-native error payload when the stream carried one. */
      detail?: unknown;
    };

export type Assembler = {
  push(frame: SseFrame): void;
  finish(): AssembleOutcome;
};

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
