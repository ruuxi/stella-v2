import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { LocalChatHistoryService } from "@stella/desktop/electron/services/local-chat-history-service.js";

const roots = new Set<string>();

const createService = () => {
  const stellaAppDir = path.join(
    os.tmpdir(),
    `stella-mobile-sync-pages-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.add(stellaAppDir);
  return new LocalChatHistoryService({ stellaAppDir });
};

const appendMessages = (
  service: LocalChatHistoryService,
  conversationId: string,
  start: number,
  count: number,
) => {
  for (let offset = 0; offset < count; offset += 1) {
    const index = start + offset;
    service.appendEvent({
      conversationId,
      eventId: `message-${String(index).padStart(6, "0")}`,
      type: index % 2 === 0 ? "assistant_message" : "user_message",
      timestamp: index,
      payload: { text: `message ${index}` },
    });
  }
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("mobile sync delta pagination", () => {
  it("returns only a small missing suffix from a valid durable cursor", () => {
    const service = createService();
    const conversationId = "small-suffix";
    appendMessages(service, conversationId, 1, 1_000);
    const checkpoint = service.syncMessages({
      conversationId,
      maxMessages: 1,
    });
    appendMessages(service, conversationId, 1_001, 2);

    const delta = service.syncMessages({
      conversationId,
      sinceCursor: checkpoint.cursor,
      maxMessages: 100,
    });

    expect(delta.cursorStatus).toBe("valid");
    expect(delta.hasMore).toBe(false);
    expect(delta.messages.map((message) => message.text)).toEqual([
      "message 1001",
      "message 1002",
    ]);
    service.close();
  });

  it("walks a large gap forward without duplicates or out-of-order rows", () => {
    const service = createService();
    const conversationId = "large-gap";
    appendMessages(service, conversationId, 1, 1);
    let cursor = service.syncMessages({
      conversationId,
      maxMessages: 1,
    }).cursor;
    appendMessages(service, conversationId, 2, 245);

    const received: string[] = [];
    const pageSizes: number[] = [];
    while (true) {
      const page = service.syncMessages({
        conversationId,
        sinceCursor: cursor,
        maxMessages: 100,
      });
      pageSizes.push(page.messages.length);
      received.push(...page.messages.map((message) => message.localMessageId));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }

    expect(pageSizes).toEqual([100, 100, 45]);
    expect(new Set(received).size).toBe(245);
    expect(received).toEqual(
      Array.from(
        { length: 245 },
        (_, index) => `message-${String(index + 2).padStart(6, "0")}`,
      ),
    );
    service.close();
  });

  it("recovers malformed and stale cursors with one bounded recent snapshot", () => {
    const service = createService();
    const conversationId = "invalid-cursor";
    appendMessages(service, conversationId, 1, 150);

    const malformed = service.syncMessages({
      conversationId,
      sinceCursor: "not-a-sync-cursor",
      maxMessages: 40,
    });
    const stale = service.syncMessages({
      conversationId,
      sinceCursor: "v2:999999:999999:missing-event",
      maxMessages: 40,
    });

    for (const recovery of [malformed, stale]) {
      expect(recovery.cursorStatus).toBe("invalid");
      expect(recovery.hasMore).toBe(false);
      expect(recovery.messages).toHaveLength(40);
      expect(recovery.messages.at(0)?.text).toBe("message 111");
      expect(recovery.messages.at(-1)?.text).toBe("message 150");
    }
    service.close();
  });

  it("uses sequence order for backdated and same-timestamp late rows", () => {
    const service = createService();
    const conversationId = "sequence-gap";
    service.appendEvent({
      conversationId,
      eventId: "cursor-z",
      type: "user_message",
      timestamp: 2_000,
      payload: { text: "checkpoint" },
    });
    const cursor = service.syncMessages({
      conversationId,
      maxMessages: 1,
    }).cursor;
    service.appendEvent({
      conversationId,
      eventId: "backdated",
      type: "assistant_message",
      timestamp: 1_500,
      payload: { text: "backdated" },
    });
    service.appendEvent({
      conversationId,
      eventId: "cursor-a",
      type: "assistant_message",
      timestamp: 2_000,
      payload: { text: "same timestamp, smaller id" },
    });

    const delta = service.syncMessages({
      conversationId,
      sinceCursor: cursor,
      maxMessages: 100,
    });
    expect(delta.messages.map((message) => message.localMessageId)).toEqual([
      "backdated",
      "cursor-a",
    ]);
    expect(delta.hasMore).toBe(false);
    service.close();
  });

  it("does not advertise continuation for events excluded from mobile sync", () => {
    const service = createService();
    const conversationId = "irrelevant-continuation";
    appendMessages(service, conversationId, 1, 1);
    const cursor = service.syncMessages({
      conversationId,
      maxMessages: 1,
    }).cursor;
    service.appendEvent({
      conversationId,
      eventId: "internal-memory",
      type: "memory",
      timestamp: 2,
      payload: { text: "not part of the mobile projection" },
    });

    const delta = service.syncMessages({
      conversationId,
      sinceCursor: cursor,
      maxMessages: 100,
    });

    expect(delta.cursorStatus).toBe("valid");
    expect(delta.messages).toEqual([]);
    expect(delta.cursor).toBe(cursor);
    expect(delta.hasMore).toBe(false);
    service.close();
  });
});
