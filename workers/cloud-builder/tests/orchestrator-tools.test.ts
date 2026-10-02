import { describe, expect, test } from "bun:test";
import type { AgentHome } from "../src/agent-home.js";
import {
  createMemoryTools,
  createScheduleTool,
  type OrchestratorToolContext,
} from "../src/orchestrator-tools.js";
import { sha256Hex } from "../src/hash.js";

type ProfileOperation = Parameters<AgentHome["applyProfileOperation"]>[0];

const profileResult = {
  ok: true,
  message: "Remembered.",
  entryCount: 1,
  bytes: 32,
};

const context = (overrides: Partial<OrchestratorToolContext> = {}) =>
  ({
    ownerId: "owner-1",
    ownerGeneration: "generation-1",
    conversationId: "conversation-1",
    agentHome: {
      async readDocuments() {
        return [];
      },
      async applyProfileOperation() {
        return profileResult;
      },
    } as unknown as AgentHome,
    async post() {
      return Response.json({ schedules: [] });
    },
    ...overrides,
  }) satisfies OrchestratorToolContext;

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject.");
};

describe("orchestrator tools", () => {
  test("Remember replays a lost response with one generation-fenced deterministic id", async () => {
    const operations: ProfileOperation[] = [];
    const committed = new Set<string>();
    const lostResponse = new Error("connection closed after commit");
    const home = {
      async applyProfileOperation(operation: ProfileOperation) {
        operations.push(operation);
        const key = operation.idempotencyKey!;
        if (!committed.has(key)) {
          committed.add(key);
          throw lostResponse;
        }
        return { ...profileResult, message: "Already remembered." };
      },
    } as unknown as AgentHome;
    const remember = createMemoryTools(context({ agentHome: home })).find(
      (tool) => tool.name === "Remember",
    )!;
    const params = {
      action: "add",
      content: "The user prefers exact acceptance receipts.",
    };

    expect(await rejectionOf(remember.execute("tool-call-1", params))).toBe(
      lostResponse,
    );
    const replay = await remember.execute("tool-call-1", params);

    const expected = `remember:${await sha256Hex(
      "remember\0generation-1\0conversation-1\0tool-call-1",
    )}`;
    expect(operations.map((operation) => operation.idempotencyKey)).toEqual([
      expected,
      expected,
    ]);
    expect(committed.size).toBe(1);
    expect(replay.content[0]).toMatchObject({
      type: "text",
      text: "Already remembered.",
    });

    let nextGenerationKey = "";
    const nextGenerationHome = {
      async applyProfileOperation(operation: ProfileOperation) {
        nextGenerationKey = operation.idempotencyKey!;
        return profileResult;
      },
    } as unknown as AgentHome;
    const nextGenerationRemember = createMemoryTools(
      context({
        ownerGeneration: "generation-2",
        agentHome: nextGenerationHome,
      }),
    ).find((tool) => tool.name === "Remember")!;
    await nextGenerationRemember.execute("tool-call-1", params);

    expect(nextGenerationKey).toBe(
      `remember:${await sha256Hex(
        "remember\0generation-2\0conversation-1\0tool-call-1",
      )}`,
    );
    expect(nextGenerationKey).not.toBe(expected);
  });
});
