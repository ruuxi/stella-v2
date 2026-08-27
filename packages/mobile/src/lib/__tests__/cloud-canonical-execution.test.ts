import { describe, expect, test } from "bun:test";
import { cancelCanonicalCloudExecution } from "../cloud-canonical-execution";

describe("mobile canonical cloud cancellation", () => {
  test("reconstructs the original stable cancel identity after restart", async () => {
    const commands: object[] = [];
    await cancelCanonicalCloudExecution({
      dispatchId: "exec:server",
      conversationId: "conversation-1",
      readStatus: async () => ({
        dispatchId: "exec:server",
        idempotencyKey: "mobile-local-message",
        conversationId: "conversation-1",
      }),
      cancel: async (command) => {
        commands.push(command);
        return command;
      },
    });

    expect(commands).toEqual([
      {
        dispatchId: "exec:server",
        cancelRequestId: "cancel:mobile-local-message",
        reason: "Stopped from the mobile conversation.",
      },
    ]);
  });

  test("reuses an already-owned cancel request and fences another conversation", async () => {
    const commands: object[] = [];
    await cancelCanonicalCloudExecution({
      dispatchId: "exec:server",
      conversationId: "conversation-1",
      readStatus: async () => ({
        dispatchId: "exec:server",
        idempotencyKey: "mobile-local-message",
        conversationId: "conversation-1",
        cancelRequestId: "cancel:already-owned",
      }),
      cancel: async (command) => {
        commands.push(command);
        return command;
      },
    });
    expect(commands[0]).toMatchObject({
      cancelRequestId: "cancel:already-owned",
    });

    let mismatch: unknown = null;
    try {
      await cancelCanonicalCloudExecution({
        dispatchId: "exec:server",
        conversationId: "conversation-2",
        readStatus: async () => ({
          dispatchId: "exec:server",
          idempotencyKey: "mobile-local-message",
          conversationId: "conversation-1",
        }),
        cancel: async (command) => command,
      });
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toBeInstanceOf(Error);
    expect(String(mismatch)).toContain("verify the running cloud turn");
  });

  test("bounds the restart fallback for a maximum-length idempotency key", async () => {
    let cancelRequestId = "";
    await cancelCanonicalCloudExecution({
      dispatchId: "exec:bounded",
      conversationId: "conversation-1",
      readStatus: async () => ({
        dispatchId: "exec:bounded",
        idempotencyKey: "a".repeat(128),
        conversationId: "conversation-1",
      }),
      cancel: async (command) => {
        cancelRequestId = command.cancelRequestId;
        return command;
      },
    });

    expect(cancelRequestId).toBe("cancel:exec:bounded");
    expect(cancelRequestId.length).toBeLessThanOrEqual(128);
  });
});
