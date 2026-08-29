import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  createStateContext,
  handleSpawnAgent,
} from "../tools/state.js";
import type { AgentToolApi, ToolContext } from "../tools/types.js";
import { initializeDesktopDatabase } from "../storage/database-init.js";
import { SessionStore } from "../storage/session-store.js";
import type { SqliteDatabase } from "../storage/shared.js";
import { toCloudExecutionSelection } from "./agent-model-config.js";
import { createCloudSpawnDispatcher } from "./cloud-spawn-dispatch.js";

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
    ...overrides,
  }) as AgentToolApi;

const managedSelection: CloudExecutionSelection = {
  engine: "stella",
  provider: "stella",
  model: "stella/anthropic/claude-sonnet-4-6",
  reasoningEffort: "medium",
};

const cloudResult = (threadId: string) => ({
  threadId,
  conversationId: "cloud-conversation",
  ownerGeneration: "owner-generation-1",
  attemptGeneration: 1,
  threadUpdatedAt: 100,
  status: "running" as const,
});

const createStore = () => {
  const database = new Database(":memory:");
  initializeDesktopDatabase(database as unknown as SqliteDatabase);
  return new SessionStore(database as unknown as SqliteDatabase);
};

describe("desktop cloud execution selection", () => {
  test("serializes an inherited managed General-agent route without an override", async () => {
    const resolutions: unknown[] = [];
    const dispatches: unknown[] = [];
    const state = createStateContext(
      "/tmp/stella-cloud-selection-test",
      agentApi({
        cloudDispatch: async (request) => {
          dispatches.push(request);
          return cloudResult("thr-cloud");
        },
      }),
      undefined,
      undefined,
      async (request) => {
        resolutions.push(request);
        return managedSelection;
      },
    );

    const result = await handleSpawnAgent(
      state,
      {
        placement: "cloud",
        description: "Research",
        prompt: "Research this subject.",
      },
      toolContext,
    );

    expect(resolutions).toEqual([{}]);
    expect(dispatches).toEqual([
      {
        conversationId: "local-conversation",
        requestId: "request-1",
        description: "Research",
        prompt: "Research this subject.",
        execution: managedSelection,
      },
    ]);
    expect(result).toMatchObject({
      result: {
        thread_id: "thr-cloud",
        placement: "cloud",
        attempt_generation: 1,
        thread_updated_at: 100,
        thread_status: "running",
      },
    });
  });

  test("carries a pinned Claude model and reasoning effort", async () => {
    const resolutions: unknown[] = [];
    const dispatches: unknown[] = [];
    const selection: CloudExecutionSelection = {
      engine: "anthropic",
      provider: "anthropic",
      model: "claude-opus-4-6",
      reasoningEffort: "high",
    };
    const state = createStateContext(
      "/tmp/stella-cloud-selection-test",
      agentApi({
        cloudDispatch: async (request) => {
          dispatches.push(request);
          return cloudResult("thr-claude");
        },
      }),
      undefined,
      undefined,
      async (request) => {
        resolutions.push(request);
        return selection;
      },
    );

    await handleSpawnAgent(
      state,
      {
        placement: "cloud",
        description: "Implement",
        prompt: "Implement the change.",
        model: "claude-code/claude-opus-4-6:high",
      },
      toolContext,
    );

    expect(resolutions).toEqual([
      {
        spawnEngine: {
          engine: "claude_code_local",
          model: "claude-opus-4-6",
        },
        reasoningEffort: "high",
      },
    ]);
    expect(dispatches).toHaveLength(1);
    expect((dispatches[0] as { execution: unknown }).execution).toEqual(
      selection,
    );
  });

  test("pins an explicit Stella-managed model instead of inheriting another route", async () => {
    const resolutions: unknown[] = [];
    const state = createStateContext(
      "/tmp/stella-cloud-selection-test",
      agentApi({
        cloudDispatch: async () => cloudResult("thr-stella"),
      }),
      () => {},
      async () => {},
      async (request) => {
        resolutions.push(request);
        return {
          engine: "stella",
          provider: "stella",
          model: "stella/openai/gpt-5.6",
          reasoningEffort: "default",
        };
      },
    );

    await handleSpawnAgent(
      state,
      {
        placement: "cloud",
        description: "Analyze",
        prompt: "Analyze the issue.",
        model: "stella/openai/gpt-5.6",
      },
      toolContext,
    );

    expect(resolutions).toEqual([
      {
        model: "stella/openai/gpt-5.6",
        spawnEngine: { engine: "default" },
      },
    ]);
  });

  test("carries a pinned Codex model and reasoning effort", async () => {
    const resolutions: unknown[] = [];
    const selection: CloudExecutionSelection = {
      engine: "openai-codex",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    };
    const state = createStateContext(
      "/tmp/stella-cloud-selection-test",
      agentApi({
        cloudDispatch: async () => cloudResult("thr-codex"),
      }),
      undefined,
      undefined,
      async (request) => {
        resolutions.push(request);
        return selection;
      },
    );

    await handleSpawnAgent(
      state,
      {
        placement: "cloud",
        description: "Review",
        prompt: "Review the implementation.",
        model: "codex/gpt-5.6-sol:xhigh",
      },
      toolContext,
    );

    expect(resolutions).toEqual([
      {
        spawnEngine: { engine: "codex_cli", model: "gpt-5.6-sol" },
        reasoningEffort: "xhigh",
      },
    ]);
  });

  test("maps only cloud-capable snapshots and rejects direct desktop providers", () => {
    expect(
      toCloudExecutionSelection({
        engine: "default",
        routeModel: "stella/openai/gpt-5.6",
        reasoningEffort: "low",
      }),
    ).toEqual({
      engine: "stella",
      provider: "stella",
      model: "stella/openai/gpt-5.6",
      reasoningEffort: "low",
    });
    expect(
      toCloudExecutionSelection({
        engine: "claude_code_local",
        routeModel: "stella/anthropic/claude-sonnet-4-6",
        engineModel: "opus",
        reasoningEffort: "medium",
      }),
    ).toEqual({
      engine: "anthropic",
      provider: "anthropic",
      model: "opus",
      reasoningEffort: "medium",
    });
    expect(() =>
      toCloudExecutionSelection({
        engine: "default",
        routeModel: "local/llama3",
        reasoningEffort: "default",
      }),
    ).toThrow("desktop-only model route");
    expect(() =>
      toCloudExecutionSelection({
        engine: "default",
        routeModel: "stella/openai-codex/gpt-5.6-sol",
        reasoningEffort: "high",
      }),
    ).toThrow("desktop-only model route");
  });

  test("includes the exact selection in the Convex spawn mutation", async () => {
    const mutations: Array<{ ref: unknown; args: unknown }> = [];
    const dispatch = createCloudSpawnDispatcher({
      convexApi: {
        cloud_apps: {
          spawnCloudAgentFromDesktop: "spawn-ref",
          listMyConversations: "list-ref",
        },
      },
      deviceId: "device-1",
      mutation: async (ref, args) => {
        mutations.push({ ref, args });
        return cloudResult("thr-cloud");
      },
      action: async () => ({}),
      query: async () => [],
      getOwnerGeneration: async () => "owner-generation-1",
      store: createStore(),
      isSignedIn: () => true,
    });

    await dispatch({
      conversationId: "local-conversation",
      requestId: "spawn-request-1",
      description: "Research",
      prompt: "Research this subject.",
      execution: managedSelection,
    });

    expect(mutations).toEqual([
      {
        ref: "spawn-ref",
        args: {
          ownerGeneration: "owner-generation-1",
          clientMsgId: "spawn-request-1",
          description: "Research",
          prompt: "Research this subject.",
          originDeviceId: "device-1",
          originConversationId: "local-conversation",
          execution: managedSelection,
        },
      },
    ]);
  });

  test("replays a lost spawn response with its captured generation and stable client id", async () => {
    const store = createStore();
    const calls: unknown[] = [];
    let currentGeneration = "owner-generation-1";
    let loseResponse = true;
    let signedIn = true;
    const options = {
      convexApi: {
        cloud_apps: {
          spawnCloudAgentFromDesktop: "spawn-ref",
          listMyConversations: "list-ref",
        },
      },
      deviceId: "device-1",
      mutation: async (_ref: unknown, args: unknown) => {
        calls.push(args);
        if (loseResponse) throw new Error("response lost after commit");
        return cloudResult("thr-replayed");
      },
      action: async () => ({}),
      query: async () => [],
      getOwnerGeneration: async () => currentGeneration,
      store,
      isSignedIn: () => signedIn,
    };
    const request = {
      conversationId: "local-conversation",
      requestId: "spawn-lost-response-1",
      description: "Research",
      prompt: "Research this subject.",
      execution: managedSelection,
    };
    await expect(createCloudSpawnDispatcher(options)(request)).rejects.toThrow(
      "response lost after commit",
    );

    currentGeneration = "owner-generation-2";
    loseResponse = false;
    const replayed = await createCloudSpawnDispatcher(options)(request);
    expect(replayed).toMatchObject({
      threadId: "thr-replayed",
      ownerGeneration: "owner-generation-1",
      attemptGeneration: 1,
      status: "running",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]).toMatchObject({
      ownerGeneration: "owner-generation-1",
      clientMsgId: "spawn-lost-response-1",
    });

    const callCount = calls.length;
    signedIn = false;
    expect(await createCloudSpawnDispatcher(options)(request)).toEqual(replayed);
    expect(calls).toHaveLength(callCount);
    await expect(
      createCloudSpawnDispatcher(options)({
        ...request,
        prompt: "A different prompt must not reuse the id.",
      }),
    ).rejects.toThrow("reused with different parameters");
    expect(calls).toHaveLength(callCount);
  });
});
