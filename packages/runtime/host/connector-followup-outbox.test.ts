import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDesktopDatabase } from "../kernel/storage/database-init";
import type { SqliteDatabase } from "../kernel/storage/shared";
import { ConnectorFollowupOutbox } from "./connector-followup-outbox";

describe("connector follow-up durable outbox", () => {
  test("retains routing and delivery across restart until Convex ACK", async () => {
    const database = new Database(":memory:");
    initializeDesktopDatabase(database as unknown as SqliteDatabase);
    let now = 100;
    const first = new ConnectorFollowupOutbox({
      database: database as unknown as SqliteDatabase,
      now: () => now,
      retryBaseMs: 10,
      deliver: async () => {
        throw new Error("offline");
      },
    });
    const target = first.armTarget({
      conversationId: "conversation-1",
      requestId: "request-1",
      backendConversationId: "conversation-1",
    });
    expect(
      first.enqueue(target, {
        deliveryId: "delivery-1",
        text: "Background work finished.",
      }),
    ).toEqual({ replayed: false });
    expect(
      first.enqueue(target, {
        deliveryId: "delivery-1",
        text: "Background work finished.",
      }),
    ).toEqual({ replayed: true });
    await first.drainNow();
    expect(first.pendingCount()).toBe(1);

    await first.stop();

    now = 10_000;
    const delivered: string[] = [];
    const recovered = new ConnectorFollowupOutbox({
      database: database as unknown as SqliteDatabase,
      now: () => now,
      retryBaseMs: 10,
      deliver: async (entry) => {
        delivered.push(entry.deliveryId);
      },
    });
    expect(recovered.targetForConversation("conversation-1")).toEqual({
      requestId: "request-1",
      backendConversationId: "conversation-1",
      initialTurnCompleted: false,
    });
    await recovered.drainNow();
    expect(delivered).toEqual(["delivery-1"]);
    expect(recovered.pendingCount()).toBe(0);
    await recovered.stop();
    database.close();
  });

  test("rehydrates routing and submits without a local completion gate", async () => {
    const database = new Database(":memory:");
    initializeDesktopDatabase(database as unknown as SqliteDatabase);
    let now = 100;
    const first = new ConnectorFollowupOutbox({
      database: database as unknown as SqliteDatabase,
      now: () => now,
      retryBaseMs: 10,
      deliver: async () => {
        throw new Error("offline");
      },
    });
    const target = first.armTarget({
      conversationId: "conversation-restart",
      requestId: "request-restart",
      backendConversationId: "conversation-restart",
    });
    first.enqueue(target, {
      deliveryId: "delivery-restart",
      text: "Finished after the desktop restarted.",
    });
    await first.drainNow();
    expect(first.pendingCount()).toBe(1);
    await first.stop();

    now = 1_000;
    const delivered: string[] = [];
    const recovered = new ConnectorFollowupOutbox({
      database: database as unknown as SqliteDatabase,
      now: () => now,
      retryBaseMs: 10,
      deliver: async (entry) => {
        delivered.push(entry.deliveryId);
      },
    });
    expect(recovered.routeForRequest("request-restart")).toEqual({
      conversationId: "conversation-restart",
      requestId: "request-restart",
      backendConversationId: "conversation-restart",
      initialTurnCompleted: false,
    });
    await recovered.drainNow();
    expect(delivered).toEqual(["delivery-restart"]);
    expect(recovered.pendingCount()).toBe(0);
    await recovered.stop();
    database.close();
  });

  test("removes superseded or canceled rows before Convex admission", async () => {
    const database = new Database(":memory:");
    initializeDesktopDatabase(database as unknown as SqliteDatabase);
    const outbox = new ConnectorFollowupOutbox({
      database: database as unknown as SqliteDatabase,
      deliver: async () => undefined,
    });
    const first = outbox.armTarget({
      conversationId: "conversation-1",
      requestId: "request-1",
      backendConversationId: "conversation-1",
    });
    outbox.enqueue(first, {
      deliveryId: "delivery-old",
      text: "Old unfinished delivery",
    });
    outbox.markInitialTurnCompleted({
      conversationId: "conversation-1",
      requestId: "request-1",
      backendConversationId: "conversation-1",
    });
    expect(
      outbox.armTarget({
        conversationId: "conversation-1",
        requestId: "request-1",
        backendConversationId: "conversation-1",
      }).initialTurnCompleted,
    ).toBe(true);

    const second = outbox.armTarget({
      conversationId: "conversation-2",
      requestId: "request-old",
      backendConversationId: "conversation-2",
    });
    outbox.enqueue(second, {
      deliveryId: "delivery-ineligible",
      text: "Never eligible",
    });
    outbox.armTarget({
      conversationId: "conversation-2",
      requestId: "request-new",
      backendConversationId: "conversation-2",
    });
    expect(outbox.pendingCount()).toBe(1);

    outbox.clearTarget("conversation-1");
    expect(outbox.pendingCount()).toBe(0);
    await outbox.stop();
    database.close();
  });
});
