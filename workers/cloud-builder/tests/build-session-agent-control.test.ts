import { describe, expect, test } from "bun:test";
import {
  createBuildSessionAgentControl,
  type BuildSessionAgentControlDependencies,
} from "../src/build-session-agent-control.js";
import {
  CLOUD_AGENT_DEPTH_LIMIT_ERROR,
  rememberCloudAgentControlReceipt,
  type CloudAgentDispatchDependencies,
} from "../src/cloud-agent-dispatch.js";
import { sampleOwnerSnapshot } from "./helpers/turn-plane-fakes.js";

const EXECUTION = {
  engine: "stella" as const,
  provider: "stella" as const,
  model: "stella/default",
  reasoningEffort: "default" as const,
};

const memoryStorage = () => {
  const values = new Map<string, unknown>();
  return {
    values,
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") values.set(key, structuredClone(value));
        else {
          for (const [entryKey, entryValue] of Object.entries(key)) {
            values.set(entryKey, structuredClone(entryValue));
          }
        }
      },
    },
  };
};

const parent = (agentDepth = 1) => ({
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  conversationId: "conversation-1",
  turnId: "parent-turn",
  threadId: "parent-thread",
  agentDepth,
  execution: EXECUTION,
});

describe("BuildSession agent orchestration", () => {
  test("dispatches a child once with depth and direct-parent lineage", async () => {
    const { storage } = memoryStorage();
    const turns: Array<{ body: Record<string, unknown>; headers: Headers }> =
      [];
    const events: unknown[] = [];
    let admissions = 0;
    const env = {
      CLOUD_BUILDER_PUBLIC_URL: "https://builder.example",
      BUILD_SESSIONS: {
        getByName: () => ({
          fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            turns.push({ body, headers: new Headers(init?.headers) });
            return Response.json({
              accepted: true,
              turnId: body.turnId,
              attemptGeneration: body.attemptGeneration,
            });
          },
        }),
      },
    };
    const dispatch: CloudAgentDispatchDependencies = {
      env: env as never,
      ownerGateAdmit: async () => {
        admissions += 1;
        return { ok: true, snapshot: sampleOwnerSnapshot() };
      },
      releaseOwnerGate: async () => undefined,
      enqueueOutbox: async (batch) => {
        events.push(...batch);
      },
      now: () => 100,
    };
    const control = createBuildSessionAgentControl({
      storage: storage as never,
      env: env as never,
      dispatch,
      parent: parent(),
      now: () => 100,
    });

    const params = { description: "Verify lineage", prompt: "Inspect it." };
    await control.execute("spawn_agent", "tool-1", params);
    await control.execute("spawn_agent", "tool-1", params);

    expect(admissions).toBe(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.headers.get("x-stella-gate-admitted")).toBe("1");
    expect(turns[0]?.body).toMatchObject({
      parentThreadId: "parent-thread",
      parentTurnId: "parent-turn",
      agentDepth: 2,
      attemptGeneration: 1,
    });
    expect(events[0]).toMatchObject({
      parentThreadId: "parent-thread",
      parentTurnId: "parent-turn",
      agentDepth: 2,
    });
  });

  test("steers a running child and starts a new attempt for a finished child", async () => {
    const running = memoryStorage();
    await rememberCloudAgentControlReceipt(running.storage as never, {
      threadId: "child-running",
      attemptGeneration: 1,
      threadUpdatedAt: 10,
      status: "running",
      turnId: "child-turn-1",
      execution: EXECUTION,
      description: "Running child",
    });
    const paths: string[] = [];
    let admissions = 0;
    const env = {
      CLOUD_BUILDER_PUBLIC_URL: "https://builder.example",
      BUILD_SESSIONS: {
        getByName: () => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            paths.push(path);
            if (path === "/steer") {
              return Response.json({
                accepted: true,
                turnId: "child-turn-1",
                attemptGeneration: 1,
              });
            }
            const body = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            return Response.json({
              accepted: true,
              turnId: body.turnId,
              attemptGeneration: body.attemptGeneration,
            });
          },
        }),
      },
    };
    const dispatch: CloudAgentDispatchDependencies = {
      env: env as never,
      ownerGateAdmit: async () => {
        admissions += 1;
        return { ok: true, snapshot: sampleOwnerSnapshot() };
      },
      releaseOwnerGate: async () => undefined,
      enqueueOutbox: async () => undefined,
    };
    const makeControl = (storage: unknown) =>
      createBuildSessionAgentControl({
        storage: storage as never,
        env: env as never,
        dispatch,
        parent: parent(),
        now: () => 20,
      } satisfies BuildSessionAgentControlDependencies);

    const steered = await makeControl(running.storage).execute(
      "send_input",
      "tool-steer",
      { thread_id: "child-running", message: "Change direction." },
    );
    expect(steered.details).toMatchObject({
      steered: true,
      attempt_generation: 1,
    });
    expect(paths).toEqual(["/steer"]);
    expect(admissions).toBe(0);

    const finished = memoryStorage();
    await rememberCloudAgentControlReceipt(finished.storage as never, {
      threadId: "child-finished",
      attemptGeneration: 1,
      threadUpdatedAt: 10,
      status: "completed",
      execution: EXECUTION,
      description: "Finished child",
    });
    const resumed = await makeControl(finished.storage).execute(
      "send_input",
      "tool-resume",
      { thread_id: "child-finished", message: "Continue." },
    );
    expect(resumed.details).toMatchObject({
      steered: false,
      attempt_generation: 2,
    });
    expect(paths.at(-1)).toBe("/turn");
    expect(admissions).toBe(1);
  });

  test("refuses spawn at depth two even if called outside the catalog", async () => {
    const { storage } = memoryStorage();
    const deps = {
      storage: storage as never,
      env: { BUILD_SESSIONS: {} } as never,
      dispatch: {} as never,
      parent: parent(2),
    };
    const control = createBuildSessionAgentControl(deps);
    await expect(
      control.execute("spawn_agent", "tool-depth", {
        description: "Too deep",
        prompt: "Do this.",
      }),
    ).rejects.toThrow(CLOUD_AGENT_DEPTH_LIMIT_ERROR);
  });
});
