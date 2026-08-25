import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalChatHistoryService } from "@stella/desktop/electron/services/local-chat-history-service.js";

const services: LocalChatHistoryService[] = [];

const createService = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-mobile-sync-task-"));
  const service = new LocalChatHistoryService({ stellaAppDir: root });
  services.push(service);
  return service;
};

afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

describe("incremental mobile task context", () => {
  it("pages older mobile history strictly and oldest-to-newest", () => {
    const service = createService();
    const conversationId = "conversation-history-before";
    for (let index = 1; index <= 7; index += 1) {
      service.appendEvent({
        conversationId,
        eventId: `message-${index}`,
        type: index % 2 === 0 ? "assistant_message" : "user_message",
        payload: { text: `message ${index}` },
        timestamp: index,
      });
      if (index === 5) {
        service.appendEvent({
          conversationId,
          eventId: "hidden-tool-row",
          type: "tool_result",
          payload: { toolName: "noop" },
          timestamp: 5.5,
        });
      }
    }

    const first = service.listSyncMessagesBefore({
      conversationId,
      beforeTimestampMs: 7,
      beforeId: "message-7",
      maxMessages: 3,
    });
    expect(first.messages.map((message) => message.localMessageId)).toEqual([
      "message-4",
      "message-5",
      "message-6",
    ]);
    expect(first.hasOlder).toBe(true);
    expect(first.oldestSourceCursor).toEqual({
      timestamp: 4,
      id: "message-4",
    });

    const second = service.listSyncMessagesBefore({
      conversationId,
      beforeTimestampMs: first.oldestSourceCursor!.timestamp,
      beforeId: first.oldestSourceCursor!.id,
      maxMessages: 3,
    });
    expect(second.messages.map((message) => message.localMessageId)).toEqual([
      "message-1",
      "message-2",
      "message-3",
    ]);
    expect(second.hasOlder).toBe(false);
  });

  it("keeps synthetic task rows with their durable source cursor", () => {
    const service = createService();
    const conversationId = "conversation-synthetic-source-cursor";
    service.appendEvent({
      conversationId,
      eventId: "older-user",
      type: "user_message",
      payload: { text: "older turn" },
      timestamp: 0,
    });
    service.appendEvent({
      conversationId,
      eventId: "spawn-user",
      type: "user_message",
      payload: { text: "start this in the background" },
      timestamp: 1,
    });
    service.appendEvent({
      conversationId,
      eventId: "spawn-agent",
      type: "agent-started",
      payload: { agentId: "agent-1", description: "Background work" },
      timestamp: 2,
    });
    service.appendEvent({
      conversationId,
      eventId: "boundary",
      type: "user_message",
      payload: { text: "newer turn" },
      timestamp: 10,
    });

    const page = service.listSyncMessagesBefore({
      conversationId,
      beforeTimestampMs: 10,
      beforeId: "boundary",
      maxMessages: 1,
    });
    expect(page.messages.map((message) => message.localMessageId)).toEqual([
      "spawn-user",
      "spawn-user:agent",
    ]);
    expect(
      page.messages.map((message) => [
        message.sourceTimestamp,
        message.sourceMessageId,
      ]),
    ).toEqual([
      [1, "spawn-user"],
      [1, "spawn-user"],
    ]);
    expect(page.oldestSourceCursor).toEqual({
      timestamp: 1,
      id: "spawn-user",
    });
    expect(page.hasOlder).toBe(true);

    const olderPage = service.listSyncMessagesBefore({
      conversationId,
      beforeTimestampMs: page.oldestSourceCursor!.timestamp,
      beforeId: page.oldestSourceCursor!.id,
      maxMessages: 1,
    });
    expect(olderPage.messages.map((message) => message.localMessageId)).toEqual(
      ["older-user"],
    );
    expect(olderPage.hasOlder).toBe(false);
  });

  it("projects current task state onto a historical page", () => {
    const service = createService();
    const conversationId = "conversation-history-task";
    service.appendEvent({
      conversationId,
      eventId: "spawn-user",
      type: "user_message",
      payload: { text: "research this" },
      timestamp: 1,
    });
    service.appendEvent({
      conversationId,
      eventId: "spawn-agent",
      type: "agent-started",
      payload: { agentId: "agent-old", description: "Old research" },
      timestamp: 2,
    });
    service.appendEvent({
      conversationId,
      eventId: "spawn-assistant",
      type: "assistant_message",
      payload: { text: "Started" },
      timestamp: 3,
    });
    service.appendEvent({
      conversationId,
      eventId: "page-boundary",
      type: "user_message",
      payload: { text: "later" },
      timestamp: 10,
    });
    service.appendEvent({
      conversationId,
      eventId: "complete-agent",
      type: "agent-completed",
      payload: {
        agentId: "agent-old",
        description: "Old research",
        resultText: "Complete",
      },
      timestamp: 20,
    });

    const page = service.listSyncMessagesBefore({
      conversationId,
      beforeTimestampMs: 10,
      beforeId: "page-boundary",
      maxMessages: 10,
    });
    const task = page.messages
      .flatMap((message) => message.tasks ?? [])
      .find((candidate) => candidate.id === "agent-old");
    expect(task).toMatchObject({ status: "completed" });
  });

  it("pages strictly by durable sequence when timestamps move backward", () => {
    const service = createService();
    const conversationId = "conversation-sequence-pages";
    service.appendEvent({
      conversationId,
      eventId: "seed",
      type: "user_message",
      payload: { text: "seed" },
      timestamp: 1_000,
    });
    let cursor = service.syncMessages({ conversationId }).cursor;
    for (let index = 1; index <= 5; index += 1) {
      service.appendEvent({
        conversationId,
        eventId: `m${index}`,
        type: "user_message",
        payload: { text: `message ${index}` },
        timestamp: 1_000 - index,
      });
    }

    const seen: string[] = [];
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const page = service.syncMessages({
        conversationId,
        sinceCursor: cursor,
        maxMessages: 2,
      });
      seen.push(...page.messages.map((message) => message.localMessageId));
      expect(page.cursor).not.toBe(cursor);
      expect(page.cursor).toMatch(/^v2:/);
      cursor = page.cursor;
    }

    expect(seen).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(
      service.syncMessages({ conversationId, sinceCursor: cursor }),
    ).toEqual({
      messages: [],
      cursor,
      cursorStatus: "valid",
      hasMore: false,
    });
  });

  it("does not read the full transcript for an empty delta", () => {
    const service = createService();
    const conversationId = "conversation-empty";
    service.appendEvent({
      conversationId,
      eventId: "user-1",
      type: "user_message",
      payload: { text: "hello" },
      timestamp: 1,
    });
    service.appendEvent({
      conversationId,
      eventId: "assistant-1",
      type: "assistant_message",
      payload: { text: "hi" },
      timestamp: 2,
    });
    const cursor = service.syncMessages({ conversationId }).cursor;
    const store = (service as unknown as { store: { listMessages: Function } })
      .store;
    const listMessages = vi.spyOn(store, "listMessages" as never);

    const delta = service.syncMessages({ conversationId, sinceCursor: cursor });

    expect(delta.messages).toEqual([]);
    expect(listMessages).not.toHaveBeenCalled();
  });

  it("replays a spawning anchor without projecting the latest 100 messages", () => {
    const service = createService();
    const conversationId = "conversation-anchor";
    service.appendEvent({
      conversationId,
      eventId: "user-spawn",
      type: "user_message",
      payload: { text: "start background work" },
      timestamp: 10,
    });
    service.appendEvent({
      conversationId,
      eventId: "agent-start",
      type: "agent-started",
      payload: { agentId: "agent-1", description: "Research" },
      timestamp: 11,
    });
    service.appendEvent({
      conversationId,
      eventId: "assistant-spawn",
      type: "assistant_message",
      payload: { text: "Working on it" },
      timestamp: 12,
    });
    service.appendEvent({
      conversationId,
      eventId: "user-later",
      type: "user_message",
      payload: { text: "another turn" },
      timestamp: 20,
    });
    service.appendEvent({
      conversationId,
      eventId: "assistant-later",
      type: "assistant_message",
      payload: { text: "another answer" },
      timestamp: 21,
    });
    const cursor = service.syncMessages({ conversationId }).cursor;
    service.appendEvent({
      conversationId,
      eventId: "agent-complete",
      type: "agent-completed",
      payload: { agentId: "agent-1", description: "Research" },
      timestamp: 22,
    });
    const store = (service as unknown as { store: { listMessages: Function } })
      .store;
    const listMessages = vi.spyOn(store, "listMessages" as never);

    const delta = service.syncMessages({ conversationId, sinceCursor: cursor });

    expect(listMessages).not.toHaveBeenCalled();
    expect(
      delta.messages.some(
        (message) => message.localMessageId === "assistant-spawn",
      ),
    ).toBe(true);
    const tasks = delta.messages.flatMap((message) => message.tasks ?? []);
    expect(tasks.find((task) => task.id === "agent-1")?.status).toBe(
      "completed",
    );
  });
});
