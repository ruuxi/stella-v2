import { describe, expect, mock, test } from "bun:test";
import type { BuildSessionAgentControlDependencies } from "../src/build-session-agent-control.js";
import type { CloudAgentDispatchDependencies } from "../src/cloud-agent-dispatch.js";
import { sampleOwnerSnapshot } from "./helpers/turn-plane-fakes.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
const { createBuildSessionAgentControl } = await import(
  "../src/build-session-agent-control.js"
);
const { CLOUD_AGENT_DEPTH_LIMIT_ERROR, rememberCloudAgentControlReceipt } =
  await import("../src/cloud-agent-dispatch.js");
mock.restore();

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

const parent = (agentDepth = 1, workspaceForkId?: string) => ({
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  conversationId: "conversation-1",
  turnId: "parent-turn",
  threadId: "parent-thread",
  agentDepth,
  execution: EXECUTION,
  ...(workspaceForkId ? { workspaceForkId } : {}),
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

  test("forks from the parent workspace and explicitly merges a child fork", async () => {
    const { storage } = memoryStorage();
    const parentForkId = `fork-${crypto.randomUUID()}`;
    const childForkId = `fork-${crypto.randomUUID()}`;
    const forkCalls: unknown[] = [];
    const mergeCalls: unknown[] = [];
    const env = {
      CLOUD_BUILDER_PUBLIC_URL: "https://builder.example",
      BUILD_SESSIONS: {
        getByName: () => ({
          fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
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
      WORLDS: {
        getByName: () => ({
          fork: async (input: unknown) => {
            forkCalls.push(input);
            return { forkId: childForkId, headManifestId: "live:child" };
          },
          merge: async (input: unknown) => {
            mergeCalls.push(input);
            return {
              applied: ["added.txt", "changed.txt"],
              deleted: ["removed.txt"],
              conflicts: ["changed.txt"],
            };
          },
        }),
      },
    };
    const dispatch: CloudAgentDispatchDependencies = {
      env: env as never,
      ownerGateAdmit: async () => ({
        ok: true,
        snapshot: sampleOwnerSnapshot(),
      }),
      releaseOwnerGate: async () => undefined,
      enqueueOutbox: async () => undefined,
    };
    const control = createBuildSessionAgentControl({
      storage: storage as never,
      env: env as never,
      dispatch,
      parent: parent(1, parentForkId),
    });

    const spawned = await control.execute("spawn_agent", "tool-fork", {
      description: "Fork child",
      prompt: "Work in isolation.",
      workspace: "fork",
    });
    const threadId = (spawned.details as { thread_id: string }).thread_id;
    expect(forkCalls).toEqual([{ kind: "fork", threadId, from: parentForkId }]);

    const merged = await control.execute("merge_workspace", "tool-merge", {
      thread_id: threadId,
      into: "shared",
    });
    expect(mergeCalls).toEqual([
      {
        from: childForkId,
        into: "shared",
        strategy: "last_writer_wins",
      },
    ]);
    expect(merged.details).toEqual({
      thread_id: threadId,
      into: "shared",
      applied_count: 2,
      deleted_count: 1,
      conflict_count: 1,
      conflicts: ["changed.txt"],
    });
  });
});
