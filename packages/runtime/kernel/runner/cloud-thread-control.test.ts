import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  createStateContext,
  handleSendInput,
  handleSpawnAgent,
} from "../tools/state.js";
import type { AgentToolApi, ToolContext } from "../tools/types.js";
import { initializeDesktopDatabase } from "../storage/database-init.js";
import { SessionStore } from "../storage/session-store.js";
import type { SqliteDatabase } from "../storage/shared.js";
import { createCloudThreadController } from "./cloud-spawn-dispatch.js";

const OWNER_GENERATION = "owner-generation-1";

const createStore = (database = new Database(":memory:")) => {
  initializeDesktopDatabase(database as unknown as SqliteDatabase);
  return {
    database,
    store: new SessionStore(database as unknown as SqliteDatabase),
  };
};

const toolContext = {
  agentType: AGENT_IDS.ORCHESTRATOR,
  conversationId: "local-conversation",
  requestId: "request-1",
  storageMode: "local",
} as ToolContext;

const agentApi = (overrides: Partial<AgentToolApi>): AgentToolApi =>
  ({
    createAgent: async () => {
      throw new Error("not used");
    },
    getAgent: async () => null,
    cancelAgent: async () => ({ canceled: false }),
    sendAgentMessage: async () => ({ delivered: false }),
    ...overrides,
  }) as AgentToolApi;

describe("desktop cloud thread controls", () => {
  test("send_input falls through to an owned cloud continuation", async () => {
    const requests: unknown[] = [];
    const state = createStateContext(
      "/tmp/stella-cloud-control-test",
      agentApi({
        cloudContinue: async (request) => {
          requests.push(request);
          return {
            delivered: true,
            control: {
              threadId: "thr-cloud",
              ownerGeneration: OWNER_GENERATION,
              attemptGeneration: 4,
              threadUpdatedAt: 400,
              status: "running",
            },
          };
        },
      }),
    );

    const result = await handleSendInput(
      state,
      {
        thread_id: "thr-cloud",
        description: "Continue report",
        message: "Add the appendix.",
      },
      { ...toolContext, ownerGeneration: OWNER_GENERATION },
    );

    expect(requests).toEqual([
      {
        threadId: "thr-cloud",
        description: "Continue report",
        message: "Add the appendix.",
        conversationId: "local-conversation",
        requestId: "request-1",
        ownerGeneration: OWNER_GENERATION,
      },
    ]);
    expect(result).toMatchObject({
      result: {
        thread_id: "thr-cloud",
        delivered: true,
        placement: "cloud",
        attempt_generation: 4,
        thread_updated_at: 400,
        thread_status: "running",
      },
    });
  });

  test("pause_agent falls through to an owned cloud cancellation", async () => {
    const canceled: unknown[] = [];
    const state = createStateContext(
      "/tmp/stella-cloud-control-test",
      agentApi({
        cloudCancel: async (request) => {
          canceled.push(request);
          return {
            canceled: true,
            control: {
              threadId: "thr-cloud",
              ownerGeneration: OWNER_GENERATION,
              attemptGeneration: 3,
              threadUpdatedAt: 350,
              status: "canceled",
            },
          };
        },
      }),
    );

    const result = await handleSpawnAgent(
      state,
      { action: "cancel", thread_id: "thr-cloud" },
      { ...toolContext, ownerGeneration: OWNER_GENERATION },
    );

    expect(canceled).toEqual([
      {
        threadId: "thr-cloud",
        conversationId: "local-conversation",
        requestId: "request-1",
        ownerGeneration: OWNER_GENERATION,
      },
    ]);
    expect(result).toMatchObject({
      result: {
        thread_id: "thr-cloud",
        canceled: true,
        placement: "cloud",
        attempt_generation: 3,
        thread_updated_at: 350,
        thread_status: "canceled",
      },
    });
  });

  test("controller binds continuation delivery to the current device and conversation", async () => {
    const mutations: Array<{ ref: unknown; args: unknown }> = [];
    const actions: Array<{ ref: unknown; args: unknown }> = [];
    const { store } = createStore();
    store.putCloudAgentThreadControl({
      threadId: "thr-cloud",
      ownerGeneration: OWNER_GENERATION,
      cloudConversationId: "cloud-conversation",
      originConversationId: "local-conversation",
      attemptGeneration: 3,
      threadUpdatedAt: 300,
      status: "completed",
    });
    const controller = createCloudThreadController({
      convexApi: {
        cloud_apps: {
          continueMyCloudAgentFromDesktop: "continue-ref",
          cancelMyCloudAgentThread: "cancel-ref",
        },
      },
      deviceId: "device-1",
      mutation: async (ref, args) => {
        mutations.push({ ref, args });
        return {
          threadId: "thr-cloud",
          conversationId: "cloud-conversation",
          attemptGeneration: 4,
          threadUpdatedAt: 400,
          status: "running",
        };
      },
      action: async (ref, args) => {
        actions.push({ ref, args });
        return {
          canceled: true,
          status: "canceled",
          threadId: "thr-cloud",
          attemptGeneration: 4,
          threadUpdatedAt: 450,
          currentControl: {
            threadId: "thr-cloud",
            attemptGeneration: 4,
            threadUpdatedAt: 450,
            status: "canceled",
          },
        };
      },
      query: async () => [],
      getOwnerGeneration: async () => OWNER_GENERATION,
      store,
      isSignedIn: () => true,
    });

    expect(
      await controller.continueThread({
        threadId: "thr-cloud",
        description: "Continue report",
        message: "Add the appendix.",
        conversationId: "local-conversation",
        requestId: "request-1",
      }),
    ).toEqual({
      delivered: true,
      control: {
        threadId: "thr-cloud",
        ownerGeneration: OWNER_GENERATION,
        attemptGeneration: 4,
        threadUpdatedAt: 400,
        status: "running",
      },
    });
    expect(
      await controller.cancelThread({
        threadId: "thr-cloud",
        conversationId: "local-conversation",
        requestId: "request-2",
      }),
    ).toEqual({
      canceled: true,
      control: {
        threadId: "thr-cloud",
        ownerGeneration: OWNER_GENERATION,
        attemptGeneration: 4,
        threadUpdatedAt: 450,
        status: "canceled",
      },
    });
    expect(mutations).toEqual([
      {
        ref: "continue-ref",
        args: {
          ownerGeneration: OWNER_GENERATION,
          threadId: "thr-cloud",
          expectedAttemptGeneration: 3,
          expectedTerminalUpdatedAt: 300,
          description: "Continue report",
          prompt: "Add the appendix.",
          originDeviceId: "device-1",
          originConversationId: "local-conversation",
          controlRequestId: "request-1",
        },
      },
    ]);
    expect(actions).toEqual([
      {
        ref: "cancel-ref",
        args: {
          ownerGeneration: OWNER_GENERATION,
          threadId: "thr-cloud",
          expectedAttemptGeneration: 4,
          expectedThreadUpdatedAt: 400,
          originDeviceId: "device-1",
          originConversationId: "local-conversation",
          controlRequestId: "request-2",
        },
      },
    ]);
  });

  test("fails closed before network when no exact thread receipt exists", async () => {
    const { store } = createStore();
    let mutations = 0;
    let actions = 0;
    const controller = createCloudThreadController({
      convexApi: {
        cloud_apps: {
          continueMyCloudAgentFromDesktop: "continue-ref",
          cancelMyCloudAgentThread: "cancel-ref",
        },
      },
      deviceId: "device-1",
      mutation: async () => {
        mutations += 1;
        return {};
      },
      action: async () => {
        actions += 1;
        return {};
      },
      getOwnerGeneration: async () => OWNER_GENERATION,
      store,
      isSignedIn: () => true,
    });

    expect(
      await controller.continueThread({
        threadId: "missing-thread",
        description: "Continue",
        message: "Continue safely.",
        conversationId: "local-conversation",
        requestId: "missing-continue",
      }),
    ).toMatchObject({
      delivered: false,
      reason: expect.stringContaining("No durable cloud control receipt"),
    });
    expect(
      await controller.cancelThread({
        threadId: "missing-thread",
        conversationId: "local-conversation",
        requestId: "missing-cancel",
      }),
    ).toMatchObject({
      canceled: false,
      reason: expect.stringContaining("No durable cloud control receipt"),
    });
    expect({ mutations, actions }).toEqual({ mutations: 0, actions: 0 });
  });

  test("restarts a lost continuation response with the immutable generation and terminal receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "stella-cloud-control-"));
    const databasePath = join(root, "control.sqlite");
    const calls: unknown[] = [];
    let firstDatabase: Database | null = null;
    let restartedDatabase: Database | null = null;
    try {
      firstDatabase = new Database(databasePath);
      const first = createStore(firstDatabase);
      first.store.putCloudAgentThreadControl({
        threadId: "thr-restart",
        ownerGeneration: OWNER_GENERATION,
        cloudConversationId: "cloud-conversation",
        originConversationId: "local-conversation",
        attemptGeneration: 7,
        threadUpdatedAt: 700,
        status: "failed",
      });
      const firstController = createCloudThreadController({
        convexApi: {
          cloud_apps: {
            continueMyCloudAgentFromDesktop: "continue-ref",
            cancelMyCloudAgentThread: "cancel-ref",
          },
        },
        deviceId: "device-1",
        mutation: async (_ref, args) => {
          calls.push(args);
          throw new Error("response lost after commit");
        },
        action: async () => ({}),
        getOwnerGeneration: async () => OWNER_GENERATION,
        store: first.store,
        isSignedIn: () => true,
      });
      expect(
        await firstController.continueThread({
          threadId: "thr-restart",
          description: "Continue report",
          message: "Add the appendix.",
          conversationId: "local-conversation",
          requestId: "continue-restart-1",
        }),
      ).toMatchObject({ delivered: false });
      firstDatabase.close();
      firstDatabase = null;

      restartedDatabase = new Database(databasePath);
      const restarted = createStore(restartedDatabase);
      let currentGeneration = "owner-generation-2";
      const restartedController = createCloudThreadController({
        convexApi: {
          cloud_apps: {
            continueMyCloudAgentFromDesktop: "continue-ref",
            cancelMyCloudAgentThread: "cancel-ref",
          },
        },
        deviceId: "device-1",
        mutation: async (_ref, args) => {
          calls.push(args);
          return {
            threadId: "thr-restart",
            conversationId: "cloud-conversation",
            attemptGeneration: 8,
            threadUpdatedAt: 800,
            status: "running",
          };
        },
        action: async () => ({}),
        getOwnerGeneration: async () => currentGeneration,
        store: restarted.store,
        isSignedIn: () => true,
      });
      const continued = await restartedController.continueThread({
        threadId: "thr-restart",
        description: "Continue report",
        message: "Add the appendix.",
        conversationId: "local-conversation",
        requestId: "continue-restart-1",
      });
      expect(continued).toMatchObject({
        delivered: true,
        control: {
          ownerGeneration: OWNER_GENERATION,
          attemptGeneration: 8,
          threadUpdatedAt: 800,
          status: "running",
        },
      });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
      expect(calls[1]).toMatchObject({
        ownerGeneration: OWNER_GENERATION,
        expectedAttemptGeneration: 7,
        expectedTerminalUpdatedAt: 700,
      });

      const replayController = createCloudThreadController({
        convexApi: {
          cloud_apps: {
            continueMyCloudAgentFromDesktop: "continue-ref",
            cancelMyCloudAgentThread: "cancel-ref",
          },
        },
        deviceId: "device-1",
        mutation: async () => {
          throw new Error("stored outcome must replay without network");
        },
        action: async () => ({}),
        getOwnerGeneration: async () => {
          throw new Error("stored outcome must not refresh owner generation");
        },
        store: restarted.store,
        isSignedIn: () => false,
      });
      expect(
        await replayController.continueThread({
          threadId: "thr-restart",
          description: "Continue report",
          message: "Add the appendix.",
          conversationId: "local-conversation",
          requestId: "continue-restart-1",
        }),
      ).toEqual(continued);
      restartedDatabase.close();
      restartedDatabase = null;
    } finally {
      try {
        firstDatabase?.close();
      } catch {
        // Best-effort test teardown.
      }
      try {
        restartedDatabase?.close();
      } catch {
        // Best-effort test teardown.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not report an old pause as success when currentControl is a successor", async () => {
    const { store } = createStore();
    store.putCloudAgentThreadControl({
      threadId: "thr-aba",
      ownerGeneration: OWNER_GENERATION,
      cloudConversationId: "cloud-conversation",
      originConversationId: "local-conversation",
      attemptGeneration: 4,
      threadUpdatedAt: 400,
      status: "running",
    });
    let actions = 0;
    const controller = createCloudThreadController({
      convexApi: {
        cloud_apps: {
          continueMyCloudAgentFromDesktop: "continue-ref",
          cancelMyCloudAgentThread: "cancel-ref",
        },
      },
      deviceId: "device-1",
      mutation: async () => ({}),
      action: async () => {
        actions += 1;
        return {
          canceled: true,
          status: "canceled",
          threadId: "thr-aba",
          attemptGeneration: 4,
          threadUpdatedAt: 450,
          currentControl: {
            threadId: "thr-aba",
            attemptGeneration: 5,
            threadUpdatedAt: 500,
            status: "running",
          },
        };
      },
      getOwnerGeneration: async () => OWNER_GENERATION,
      store,
      isSignedIn: () => true,
    });
    const paused = await controller.cancelThread({
      threadId: "thr-aba",
      conversationId: "local-conversation",
      requestId: "pause-aba-1",
    });
    expect(paused).toMatchObject({
      canceled: false,
      reason: expect.stringContaining("newer attempt"),
      control: { attemptGeneration: 5, status: "running" },
    });
    expect(
      store.getCloudAgentThreadControl("thr-aba", OWNER_GENERATION),
    ).toMatchObject({
      attemptGeneration: 5,
      threadUpdatedAt: 500,
      status: "running",
    });
    expect(
      await controller.cancelThread({
        threadId: "thr-aba",
        conversationId: "local-conversation",
        requestId: "pause-aba-1",
      }),
    ).toEqual(paused);
    expect(actions).toBe(1);
  });

  test("terminal control wins an equal-clock race and cannot be resurrected", () => {
    const { store } = createStore();
    const base = {
      threadId: "thr-clock",
      ownerGeneration: OWNER_GENERATION,
      cloudConversationId: "cloud-conversation",
      originConversationId: "local-conversation",
      attemptGeneration: 2,
      threadUpdatedAt: 200,
    } as const;
    store.putCloudAgentThreadControl({ ...base, status: "running" });
    store.putCloudAgentThreadControl({ ...base, status: "completed" });
    store.putCloudAgentThreadControl({
      ...base,
      threadUpdatedAt: 250,
      status: "running",
    });
    expect(
      store.getCloudAgentThreadControl("thr-clock", OWNER_GENERATION),
    ).toMatchObject({
      attemptGeneration: 2,
      threadUpdatedAt: 200,
      status: "completed",
    });

    store.putCloudAgentThreadControl({
      ...base,
      attemptGeneration: 3,
      threadUpdatedAt: 150,
      status: "running",
    });
    expect(
      store.getCloudAgentThreadControl("thr-clock", OWNER_GENERATION),
    ).toMatchObject({
      attemptGeneration: 3,
      threadUpdatedAt: 150,
      status: "running",
    });
  });

  test("does not claim a completed thread was canceled by a late pause", async () => {
    const { store } = createStore();
    store.putCloudAgentThreadControl({
      threadId: "thr-terminal-race",
      ownerGeneration: OWNER_GENERATION,
      cloudConversationId: "cloud-conversation",
      originConversationId: "local-conversation",
      attemptGeneration: 6,
      threadUpdatedAt: 600,
      status: "completed",
    });
    const controller = createCloudThreadController({
      convexApi: {
        cloud_apps: {
          continueMyCloudAgentFromDesktop: "continue-ref",
          cancelMyCloudAgentThread: "cancel-ref",
        },
      },
      deviceId: "device-1",
      mutation: async () => ({}),
      action: async () => ({
        canceled: true,
        status: "completed",
        threadId: "thr-terminal-race",
        attemptGeneration: 6,
        threadUpdatedAt: 600,
        currentControl: {
          threadId: "thr-terminal-race",
          attemptGeneration: 6,
          threadUpdatedAt: 600,
          status: "completed",
        },
      }),
      getOwnerGeneration: async () => OWNER_GENERATION,
      store,
      isSignedIn: () => true,
    });

    expect(
      await controller.cancelThread({
        threadId: "thr-terminal-race",
        conversationId: "local-conversation",
        requestId: "late-pause-1",
      }),
    ).toMatchObject({
      canceled: false,
      reason: expect.stringContaining("already completed"),
      control: { status: "completed", attemptGeneration: 6 },
    });
  });

  test("replays the exact continuation outcome when terminal state races ahead", async () => {
    const { store } = createStore();
    store.putCloudAgentThreadControl({
      threadId: "thr-fast-terminal",
      ownerGeneration: OWNER_GENERATION,
      cloudConversationId: "cloud-conversation",
      originConversationId: "local-conversation",
      attemptGeneration: 2,
      threadUpdatedAt: 200,
      status: "completed",
    });
    let mutations = 0;
    const controller = createCloudThreadController({
      convexApi: {
        cloud_apps: {
          continueMyCloudAgentFromDesktop: "continue-ref",
          cancelMyCloudAgentThread: "cancel-ref",
        },
      },
      deviceId: "device-1",
      mutation: async () => {
        mutations += 1;
        store.putCloudAgentThreadControl({
          threadId: "thr-fast-terminal",
          ownerGeneration: OWNER_GENERATION,
          cloudConversationId: "cloud-conversation",
          originConversationId: "local-conversation",
          attemptGeneration: 3,
          threadUpdatedAt: 301,
          status: "completed",
        });
        return {
          threadId: "thr-fast-terminal",
          conversationId: "cloud-conversation",
          attemptGeneration: 3,
          threadUpdatedAt: 300,
          status: "running",
        };
      },
      action: async () => ({}),
      getOwnerGeneration: async () => OWNER_GENERATION,
      store,
      isSignedIn: () => true,
    });
    const request = {
      threadId: "thr-fast-terminal",
      description: "Continue",
      message: "One more check.",
      conversationId: "local-conversation",
      requestId: "fast-terminal-continue-1",
    };
    const first = await controller.continueThread(request);
    expect(first).toMatchObject({
      delivered: true,
      control: {
        attemptGeneration: 3,
        threadUpdatedAt: 300,
        status: "running",
      },
    });
    expect(
      store.getCloudAgentThreadControl(
        "thr-fast-terminal",
        OWNER_GENERATION,
      ),
    ).toMatchObject({
      attemptGeneration: 3,
      threadUpdatedAt: 301,
      status: "completed",
    });
    expect(await controller.continueThread(request)).toEqual(first);
    expect(mutations).toBe(1);
  });
});
