import { describe, expect, test } from "bun:test";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  createStateContext,
  handleSpawnAgent,
} from "../tools/state.js";
import type { AgentToolApi, ToolContext } from "../tools/types.js";
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

describe("desktop cloud execution selection", () => {
  test("serializes an inherited managed General-agent route without an override", async () => {
    const resolutions: unknown[] = [];
    const dispatches: unknown[] = [];
    const state = createStateContext(
      "/tmp/stella-cloud-selection-test",
      agentApi({
        cloudDispatch: async (request) => {
          dispatches.push(request);
          return {
            threadId: "thr-cloud",
            conversationId: "cloud-conversation",
          };
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
        workspace: "cloud",
        description: "Research",
        prompt: "Research this subject.",
      },
      toolContext,
    );

    expect(resolutions).toEqual([{}]);
    expect(dispatches).toEqual([
      {
        workspace: "cloud",
        conversationId: "local-conversation",
        description: "Research",
        prompt: "Research this subject.",
        execution: managedSelection,
      },
    ]);
    expect(result).toMatchObject({
      result: { thread_id: "thr-cloud", placement: "cloud" },
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
          return {
            threadId: "thr-claude",
            conversationId: "cloud-conversation",
          };
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
        workspace: "cloud",
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
        cloudDispatch: async () => ({
          threadId: "thr-stella",
          conversationId: "cloud-conversation",
        }),
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
        workspace: "cloud",
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
        cloudDispatch: async () => ({
          threadId: "thr-codex",
          conversationId: "cloud-conversation",
        }),
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
        workspace: "cloud",
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
        return {
          threadId: "thr-cloud",
          conversationId: "cloud-conversation",
        };
      },
      action: async () => ({}),
      query: async () => [],
      isSignedIn: () => true,
    });

    await dispatch({
      workspace: "cloud",
      conversationId: "local-conversation",
      description: "Research",
      prompt: "Research this subject.",
      execution: managedSelection,
    });

    expect(mutations).toEqual([
      {
        ref: "spawn-ref",
        args: {
          workspace: "cloud",
          description: "Research",
          prompt: "Research this subject.",
          originDeviceId: "device-1",
          originConversationId: "local-conversation",
          execution: managedSelection,
        },
      },
    ]);
  });
});
