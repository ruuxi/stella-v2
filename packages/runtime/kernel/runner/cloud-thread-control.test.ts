import { describe, expect, test } from "bun:test";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  createStateContext,
  handleSendInput,
  handleSpawnAgent,
} from "../tools/state.js";
import type { AgentToolApi, ToolContext } from "../tools/types.js";
import { createCloudThreadController } from "./cloud-spawn-dispatch.js";

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
          return { delivered: true };
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
      toolContext,
    );

    expect(requests).toEqual([
      {
        threadId: "thr-cloud",
        description: "Continue report",
        message: "Add the appendix.",
        conversationId: "local-conversation",
        requestId: "request-1",
      },
    ]);
    expect(result).toMatchObject({
      result: {
        thread_id: "thr-cloud",
        delivered: true,
        placement: "cloud",
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
          return { canceled: true };
        },
      }),
    );

    const result = await handleSpawnAgent(
      state,
      { action: "cancel", thread_id: "thr-cloud" },
      toolContext,
    );

    expect(canceled).toEqual([
      {
        threadId: "thr-cloud",
        conversationId: "local-conversation",
        requestId: "request-1",
      },
    ]);
    expect(result).toMatchObject({
      result: {
        thread_id: "thr-cloud",
        canceled: true,
        placement: "cloud",
      },
    });
  });

  test("controller binds continuation delivery to the current device and conversation", async () => {
    const mutations: Array<{ ref: unknown; args: unknown }> = [];
    const actions: Array<{ ref: unknown; args: unknown }> = [];
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
        return { threadId: "thr-cloud", conversationId: "cloud-conversation" };
      },
      action: async (ref, args) => {
        actions.push({ ref, args });
        return { canceled: true, status: "canceled" };
      },
      query: async () => [],
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
    ).toEqual({ delivered: true });
    expect(
      await controller.cancelThread({
        threadId: "thr-cloud",
        conversationId: "local-conversation",
        requestId: "request-2",
      }),
    ).toEqual({ canceled: true });
    expect(mutations).toEqual([
      {
        ref: "continue-ref",
        args: {
          threadId: "thr-cloud",
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
          threadId: "thr-cloud",
          originDeviceId: "device-1",
          originConversationId: "local-conversation",
          controlRequestId: "request-2",
        },
      },
    ]);
  });
});
