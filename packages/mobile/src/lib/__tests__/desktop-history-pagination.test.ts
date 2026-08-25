import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../types";
import {
  fetchDesktopHistoryBeforePage,
  LEGACY_DESKTOP_HISTORY_MAX,
} from "../desktop-history-pagination";

const row = (index: number): ChatMessage => ({
  id: `row-${String(index).padStart(4, "0")}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text: String(index),
  createdAt: index,
});

describe("desktop history feature negotiation", () => {
  test("uses the keyset endpoint exactly when the desktop advertises it", async () => {
    let legacyCalls = 0;
    const expected = { messages: [row(40)], hasOlder: true };
    const page = await fetchDesktopHistoryBeforePage(
      {
        beforeTimestampMs: 50,
        beforeId: "row-0050",
        maxMessages: 10,
        legacyMaxMessages: 20,
      },
      {
        supportsHistoryBefore: true,
        invokeHistoryBefore: async () => expected,
        fetchRecent: async () => {
          legacyCalls += 1;
          return [];
        },
      },
    );
    expect(page).toEqual({ ...expected, usedLegacyFallback: false });
    expect(legacyCalls).toBe(0);
  });

  test("slices the legacy recent window before a timestamp/id cursor", async () => {
    let nativeCalls = 0;
    let requestedLimit = 0;
    const messages = Array.from({ length: 120 }, (_, index) => row(index));
    const page = await fetchDesktopHistoryBeforePage(
      {
        beforeTimestampMs: 100,
        beforeId: "row-0100",
        maxMessages: 20,
        legacyMaxMessages: 120,
      },
      {
        supportsHistoryBefore: false,
        invokeHistoryBefore: async () => {
          nativeCalls += 1;
          return { messages: [], hasOlder: false };
        },
        fetchRecent: async (limit) => {
          requestedLimit = limit;
          return messages.slice(-limit);
        },
      },
    );
    expect(nativeCalls).toBe(0);
    expect(requestedLimit).toBe(120);
    expect(page.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => row(80 + index).id),
    );
    expect(page.hasOlder).toBe(true);
    expect(page.usedLegacyFallback).toBe(true);
  });

  test("keeps expanding when a full legacy window yields exactly one page", async () => {
    const messages = Array.from({ length: 180 }, (_, index) => row(index));
    const page = await fetchDesktopHistoryBeforePage(
      {
        beforeTimestampMs: 80,
        beforeId: "row-0080",
        maxMessages: 80,
        legacyMaxMessages: 180,
      },
      {
        supportsHistoryBefore: false,
        invokeHistoryBefore: async () => ({ messages: [], hasOlder: false }),
        fetchRecent: async () => messages,
      },
    );
    expect(page.messages).toHaveLength(80);
    expect(page.hasOlder).toBe(true);
  });

  test("preserves desktop sequence order when legacy timestamps move backwards", async () => {
    const messages = Array.from({ length: 120 }, (_, index) => ({
      ...row(index),
      createdAt: index === 100 ? -10_000 : 10_000 - index,
      sourceTimestamp: index === 100 ? -10_000 : 10_000 - index,
      sourceMessageId: row(index).id,
    }));
    const page = await fetchDesktopHistoryBeforePage(
      {
        beforeTimestampMs: -10_000,
        beforeId: "row-0100",
        maxMessages: 20,
        legacyMaxMessages: 120,
      },
      {
        supportsHistoryBefore: false,
        invokeHistoryBefore: async () => ({ messages: [], hasOlder: false }),
        fetchRecent: async () => messages,
      },
    );

    expect(page.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => row(80 + index).id),
    );
  });

  test("caps compatibility expansion at 1k rows", async () => {
    let requestedLimit = 0;
    await fetchDesktopHistoryBeforePage(
      {
        beforeTimestampMs: 2_000,
        beforeId: "row-2000",
        maxMessages: 80,
        legacyMaxMessages: 10_000,
      },
      {
        supportsHistoryBefore: false,
        invokeHistoryBefore: async () => ({ messages: [], hasOlder: false }),
        fetchRecent: async (limit) => {
          requestedLimit = limit;
          return [];
        },
      },
    );
    expect(requestedLimit).toBe(LEGACY_DESKTOP_HISTORY_MAX);
  });
});
