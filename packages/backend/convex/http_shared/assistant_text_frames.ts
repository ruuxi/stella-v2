import type { AssistantMessageEvent } from "../runtime_ai/types";

/**
 * Assistant text is delivered whole. Provider deltas accumulate per content
 * block and are released as ONE segment when the block closes (`text_end`),
 * so a client renders a finished message instead of a typewriter.
 *
 * One segment per text BLOCK — not one per response — keeps a tool-calling
 * loop's interleaving intact: text → toolCall → text stays in wire order for
 * any caller that also emits tool frames.
 */
export type AssistantTextFramer = {
  /**
   * Feeds one provider event and returns the whole segments it releases, in
   * content-block order. Every other event type returns nothing.
   */
  accept: (event: AssistantMessageEvent) => string[];
  /**
   * Releases everything still buffered. The stream loop does not need this —
   * `done` already flushes — but a caller that emits its own non-text frames
   * mid-stream calls it first so the text that opened before them lands ahead
   * of them.
   */
  flush: () => string[];
};

export const createAssistantTextFramer = (): AssistantTextFramer => {
  const pending = new Map<number, string>();

  const drain = (contentIndex?: number): string[] => {
    const released: string[] = [];
    for (const [index, text] of [...pending.entries()].sort(
      (left, right) => left[0] - right[0],
    )) {
      if (contentIndex !== undefined && index !== contentIndex) continue;
      pending.delete(index);
      if (text) released.push(text);
    }
    return released;
  };

  return {
    accept: (event) => {
      switch (event.type) {
        case "text_delta":
          pending.set(
            event.contentIndex,
            (pending.get(event.contentIndex) ?? "") + event.delta,
          );
          return [];
        case "text_end":
          // Providers report the canonical block text here; prefer it over the
          // accumulated deltas, which some of them re-emit in full.
          pending.set(event.contentIndex, event.content);
          return drain(event.contentIndex);
        case "done":
          // Safety net for a provider that ends a stream without closing its
          // text block.
          return drain();
        default:
          // An errored stream drops whatever block was still open: half a
          // reply on screen is worse than none.
          return [];
      }
    },
    flush: () => drain(),
  };
};
