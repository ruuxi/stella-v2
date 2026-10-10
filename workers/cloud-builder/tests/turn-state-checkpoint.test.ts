import { describe, expect, test } from "bun:test";
import {
  parseTurnStateCheckpointRequest,
  replaceTurnStateArchiveSession,
} from "../src/turn-state-checkpoint.js";

const cursor = `v1:${"a".repeat(64)}`;
describe("turn-state checkpoint request", () => {
  test("accepts a cursor-only request and refuses unknown fields", () => {
    expect(
      parseTurnStateCheckpointRequest({ schemaVersion: 1, historyCursor: cursor }),
    ).toEqual({ schemaVersion: 1, historyCursor: cursor });
    expect(
      parseTurnStateCheckpointRequest({
        schemaVersion: 1,
        historyCursor: cursor,
        suspensionTranscript: [],
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
