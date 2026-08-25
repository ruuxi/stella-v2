import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../types";
import {
  mergeNewerTranscriptPage,
  mergeOlderTranscriptPage,
} from "../chat-transcript-window";

const row = (index: number): ChatMessage => ({
  id: `row-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text: String(index),
  createdAt: index,
});

describe("bounded transcript window", () => {
  test("walks 10k rows in both directions without exceeding the cap", () => {
    const all = Array.from({ length: 10_000 }, (_, index) => row(index));
    const maxLoaded = 480;
    let window = all.slice(-160);
    for (let end = 9_840; end > 0; end -= 80) {
      const start = Math.max(0, end - 80);
      window = mergeOlderTranscriptPage(
        window,
        all.slice(start, end),
        maxLoaded,
      ).messages;
      expect(window.length).toBeLessThanOrEqual(maxLoaded);
    }
    expect(window[0]?.id).toBe("row-0");

    for (let start = window.length; start < all.length; start += 80) {
      window = mergeNewerTranscriptPage(
        window,
        all.slice(start, start + 80),
        maxLoaded,
      ).messages;
      expect(window.length).toBeLessThanOrEqual(maxLoaded);
    }
    expect(window.at(-1)?.id).toBe("row-9999");
  });

  test("deduplicates canonical overlap without replacing stable local rows", () => {
    const local: ChatMessage = {
      ...row(10),
      id: "local-10",
      canonicalId: "row-10",
    };
    const result = mergeOlderTranscriptPage(
      [local, row(11)],
      [row(9), row(10)],
      10,
    );
    expect(result.messages.map((message) => message.id)).toEqual([
      "row-9",
      "local-10",
      "row-11",
    ]);
    expect(result.messages[1]).toBe(local);
  });

  test("evicts only the edge opposite the requested page", () => {
    const current = Array.from({ length: 6 }, (_, index) => row(index + 10));
    const older = mergeOlderTranscriptPage(current, [row(8), row(9)], 6);
    expect(older.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 6 }, (_, index) => `row-${index + 8}`),
    );
    expect(older.droppedNewer).toBe(true);

    const newer = mergeNewerTranscriptPage(current, [row(16), row(17)], 6);
    expect(newer.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 6 }, (_, index) => `row-${index + 12}`),
    );
    expect(newer.droppedOlder).toBe(true);
  });
});
