import { describe, expect, test } from "bun:test";
import {
  parseTurnStateCheckpointRequest,
  replaceTurnStateArchiveSession,
} from "../src/turn-state-checkpoint.js";

const cursor = `v1:${"a".repeat(64)}`;
const suspensionTranscript = [
  {
    ordinal: 0,
    role: "user",
    payloadJson: JSON.stringify({ role: "user", content: [] }),
  },
  {
    ordinal: 1,
    role: "assistant",
    payloadJson: JSON.stringify({
      role: "assistant",
      content: [{ type: "toolCall", id: "outer-code-call", name: "code" }],
    }),
  },
];

describe("turn-state checkpoint request", () => {
  test("accepts an exact bounded suspension transcript", () => {
    expect(
      parseTurnStateCheckpointRequest({
        schemaVersion: 1,
        historyCursor: cursor,
        suspensionTranscript,
      }),
    ).toEqual({
      schemaVersion: 1,
      historyCursor: cursor,
      suspensionTranscript,
    });
  });

  test("rejects role drift, ordinal gaps, and unbounded transcript bytes", () => {
    expect(
      parseTurnStateCheckpointRequest({
        schemaVersion: 1,
        historyCursor: cursor,
        suspensionTranscript: [
          {
            ordinal: 0,
            role: "assistant",
            payloadJson: JSON.stringify({ role: "user", content: [] }),
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseTurnStateCheckpointRequest({
        schemaVersion: 1,
        historyCursor: cursor,
        suspensionTranscript: [
          {
            ordinal: 1,
            role: "assistant",
            payloadJson: JSON.stringify({ role: "assistant", content: [] }),
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseTurnStateCheckpointRequest({
        schemaVersion: 1,
        historyCursor: cursor,
        suspensionTranscript: [
          {
            ordinal: 0,
            role: "assistant",
            payloadJson: JSON.stringify({
              role: "assistant",
              content: "x".repeat(4 * 1024 * 1024),
            }),
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("turn-state checkpoint archive session", () => {
  test("replaces only the helper session without killing the awaiting executor", async () => {
    let executorAlive = true;
    const deleted: string[] = [];
    const created: Array<Record<string, unknown>> = [];
    const sandbox = {
      killAllProcesses: async () => {
        executorAlive = false;
      },
      deleteSession: async (sessionId: string) => {
        deleted.push(sessionId);
      },
      createSession: async (options: Record<string, unknown>) => {
        created.push(options);
        return { id: options.id };
      },
    };

    const session = await replaceTurnStateArchiveSession({
      sandbox,
      sessionId: "turn-state-turn-1-request-1",
      commandTimeoutMs: 120_000,
    });

    expect(executorAlive).toBe(true);
    expect(deleted).toEqual(["turn-state-turn-1-request-1"]);
    expect(created).toEqual([
      {
        id: "turn-state-turn-1-request-1",
        cwd: "/opt/stella",
        commandTimeoutMs: 120_000,
      },
    ]);
    expect(session).toEqual({ id: "turn-state-turn-1-request-1" });
  });

  test("recreates the helper session when no stale session exists", async () => {
    const created: string[] = [];
    const session = await replaceTurnStateArchiveSession({
      sandbox: {
        deleteSession: async () => {
          throw new Error("session not found");
        },
        createSession: async ({ id }) => {
          created.push(id);
          return { id };
        },
      },
      sessionId: "turn-state-turn-2-request-2",
      commandTimeoutMs: 60_000,
    });

    expect(created).toEqual(["turn-state-turn-2-request-2"]);
    expect(session).toEqual({ id: "turn-state-turn-2-request-2" });
  });
});
