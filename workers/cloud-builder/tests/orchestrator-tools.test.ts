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
    recall: {
      search: () => [],
      hydrate: async () => [],
    },
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

  test("Recall honors cancellation", async () => {
    const recallAbort = new Error("recall turn canceled");
    const recallController = new AbortController();
    let recallHydrated = false;
    const recall = createMemoryTools(
      context({
        recall: {
          search: () => [
            {
              seq: 10,
              turnId: "turn-1",
              role: "assistant",
              createdAt: 1,
              snippet: "prior work",
              rank: -1,
            },
          ],
          hydrate: async () => {
            recallHydrated = true;
            recallController.abort(recallAbort);
            throw new Error("hydrate stopped");
          },
        },
      }),
    ).find((tool) => tool.name === "Recall")!;
    expect(
      await rejectionOf(
        recall.execute(
          "tool-call-recall",
          {
            prompt: "Find prior work",
            memorySearchTerms: ["project", "status"],
          },
          recallController.signal,
        ),
      ),
    ).toBe(recallAbort);
    expect(recallHydrated).toBe(true);
  });

  test("Recall renders hydrated canonical text once and stays within its budget", async () => {
    const limits: number[] = [];
    const hits = Array.from({ length: 20 }, (_, index) => ({
      seq: 10 + index,
      turnId: `turn-${index}`,
      role: index % 2 === 0 ? "assistant" : "user",
      createdAt: Date.UTC(2026, 0, 1, 0, 0, index),
      snippet: "digest-only snippet",
      rank: -20 + index,
    }));
    const recall = createMemoryTools(
      context({
        recall: {
          search: (_terms, limit) => {
            limits.push(limit);
            return hits;
          },
          hydrate: async (seq) => {
            const recordSeq = seq;
            const marker = String(seq);
            return [
              {
                seq: recordSeq,
                kind: "message" as const,
                turnId: `turn-${seq - 10}`,
                createdAtMs: Date.UTC(2026, 0, 1),
                role: "assistant" as const,
                hidden: false,
                payload: {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: `hydrated detail ${marker} ${"x".repeat(2_000)}`,
                    },
                  ],
                },
              },
            ];
          },
        },
      }),
    ).find((tool) => tool.name === "Recall")!;

    const result = await recall.execute("tool-call-recall", {
      prompt: "Find the old implementation detail",
      memorySearchTerms: ["implementation detail"],
    });
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(limits).toEqual([12]);
    expect(text).toContain(
      "[2026-01-01T00:00:00.000Z] Stella (messageRef=recall:conversation-1:10%2Fturn-0:0)",
    );
    expect(text).toContain("hydrated detail 10");
    expect(text.match(/hydrated detail 10/gu)).toHaveLength(1);
    expect(text).not.toContain("digest-only snippet");
    expect(text.length).toBeLessThanOrEqual(12_100);
    expect(result.details).toMatchObject({ status: "found", matchCount: 12 });
  });
});

test("Recall never reads profile documents or counts them as transcript matches", async () => {
  const recall = createMemoryTools(
    context({
      agentHome: {
        async readDocuments() {
          throw new Error("Recall must not read documents already in context");
        },
      } as unknown as AgentHome,
    }),
  ).find((tool) => tool.name === "Recall")!;
  const result = await recall.execute("empty", {
    prompt: "old choice",
    memorySearchTerms: ["choice"],
  });
  expect(result.details).toMatchObject({
    status: "no_match",
    matchCount: 0,
  });
});

test("Recall reports missing canonical messages as retrieval errors", async () => {
  const recall = createMemoryTools(
    context({
      recall: {
        search: () => [
          {
            seq: 1,
            turnId: "missing",
            role: "user",
            createdAt: 1000,
            snippet: "stale",
            rank: -1,
          },
        ],
        hydrate: async () => [],
      },
    }),
  ).find((tool) => tool.name === "Recall")!;
  const result = await recall.execute("missing", {
    prompt: "old choice",
    memorySearchTerms: ["choice"],
  });
  expect(result.details).toMatchObject({ status: "retrieval_error" });
});
