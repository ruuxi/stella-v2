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

  test("Schedule replays a lost response without changing its id or interval anchor", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const rows = new Map<string, Record<string, unknown>>();
    const lostResponse = new Error("response lost after schedule commit");
    let loseFirstResponse = true;
    const post: OrchestratorToolContext["post"] = async (
      path,
      body,
      signal,
    ) => {
      expect(path).toBe("/api/cloud/schedule");
      expect(signal).toBeInstanceOf(AbortSignal);
      const request = structuredClone(body) as Record<string, unknown>;
      requests.push(request);
      const requestId = String(request.requestId);
      let row = rows.get(requestId);
      if (!row) {
        const schedule = request.schedule as Record<string, unknown>;
        // The server, not the retrying client, chooses the first committed
        // interval anchor. A replay must return this exact row.
        row = {
          scheduleId: "schedule-1",
          schedule: { ...schedule, anchorMs: 10_000 },
          nextRunAt: 910_000,
        };
        rows.set(requestId, row);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw lostResponse;
        }
      }
      return Response.json({ schedule: row });
    };
    const tool = createScheduleTool(context({ post }));
    const controller = new AbortController();
    const params = {
      action: "create",
      prompt: "Check the project status.",
      description: "Check project status",
      when: { kind: "every", every_minutes: 15 },
    };

    expect(
      await rejectionOf(tool.execute("tool-call-1", params, controller.signal)),
    ).toBe(lostResponse);
    const replay = await tool.execute(
      "tool-call-1",
      params,
      controller.signal,
    );

    const expectedRequestId = await sha256Hex(
      "schedule\0generation-1\0conversation-1\0tool-call-1",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.requestId).toBe(expectedRequestId);
    expect(requests[0]?.schedule).toEqual({
      kind: "every",
      everyMs: 900_000,
    });
    expect(requests[0]?.schedule).not.toHaveProperty("anchorMs");
    expect(rows.size).toBe(1);
    expect(replay.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("1970-01-01T00:15:10.000Z"),
    });

    let nextGenerationRequest: Record<string, unknown> | undefined;
    const nextGenerationTool = createScheduleTool(
      context({
        ownerGeneration: "generation-2",
        post: async (_path, body) => {
          nextGenerationRequest = body as Record<string, unknown>;
          return Response.json({ schedules: [] });
        },
      }),
    );
    await nextGenerationTool.execute("tool-call-1", params);
    expect(nextGenerationRequest?.requestId).toBe(
      await sha256Hex(
        "schedule\0generation-2\0conversation-1\0tool-call-1",
      ),
    );
    expect(nextGenerationRequest?.requestId).not.toBe(expectedRequestId);
  });

  test("Schedule and Recall propagate the caller abort signal", async () => {
    const scheduleAbort = new Error("schedule turn canceled");
    const scheduleController = new AbortController();
    scheduleController.abort(scheduleAbort);
    let schedulePosted = false;
    const schedule = createScheduleTool(
      context({
        post: async (_path, _body, signal) => {
          schedulePosted = true;
          expect(signal).toBe(scheduleController.signal);
          signal!.throwIfAborted();
          return Response.json({ schedules: [] });
        },
      }),
    );
    expect(
      await rejectionOf(
        schedule.execute(
          "tool-call-abort",
          { action: "list" },
          scheduleController.signal,
        ),
      ),
    ).toBe(scheduleAbort);
    expect(schedulePosted).toBe(true);

    const recallAbort = new Error("recall turn canceled");
    const recallController = new AbortController();
    let recallPosted = false;
    const recall = createMemoryTools(
      context({
        post: async (_path, _body, signal) => {
          recallPosted = true;
          expect(signal).toBe(recallController.signal);
          recallController.abort(recallAbort);
          signal!.throwIfAborted();
          return Response.json({ matches: [] });
        },
      }),
    ).find((tool) => tool.name === "Recall")!;
    expect(
      await rejectionOf(
        recall.execute(
          "tool-call-recall",
          { prompt: "Find prior work", memorySearchTerms: ["project", "status"] },
          recallController.signal,
        ),
      ),
    ).toBe(recallAbort);
    expect(recallPosted).toBe(true);
  });
});
