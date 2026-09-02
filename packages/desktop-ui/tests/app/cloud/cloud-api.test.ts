import { describe, expect, test } from "vitest";
import { getFunctionName, type FunctionArgs } from "convex/server";
import { cloudApi } from "../../../src/features/cloud/cloud-api";

describe("cloud API references", () => {
  test("targets the restored canonical conversation functions", () => {
    expect(getFunctionName(cloudApi.getCloudRealtimeConfig)).toBe(
      "cloud_apps:getCloudRealtimeConfig",
    );
    expect(getFunctionName(cloudApi.getMyCloudConversationIdentity)).toBe(
      "cloud_apps:getMyCloudConversationIdentity",
    );
    expect(getFunctionName(cloudApi.getModelGatewayConfig)).toBe(
      "gateway_capabilities:getModelGatewayConfig",
    );
    // Desktop turn starts go to the builder's turn route, not a mutation,
    // and placement is the owner gate's HTTP surface rather than Convex.
    expect(cloudApi).not.toHaveProperty("startCloudChat");
    expect(cloudApi).not.toHaveProperty("submitBrowserExecution");
    expect(cloudApi).not.toHaveProperty("getExecutionDispatchStatus");
    expect(cloudApi).not.toHaveProperty("cancelExecutionDispatch");
    expect(cloudApi).not.toHaveProperty("listMyExecutionDestinations");
    expect(cloudApi).not.toHaveProperty("getMyExecutionPlacementIdentity");
    expect(getFunctionName(cloudApi.listMyRecentAgentThreads)).toBe(
      "cloud_apps:listMyRecentAgentThreads",
    );
    expect(getFunctionName(cloudApi.listMyAgentThreadsPage)).toBe(
      "cloud_apps:listMyAgentThreadsPage",
    );
    expect(getFunctionName(cloudApi.listMyRunningAgentThreads)).toBe(
      "cloud_apps:listMyRunningAgentThreads",
    );
  });

  test("keys agent-thread pagination to the authenticated identity revision", () => {
    const args = {
      conversationId: "conversation-1",
      identityRevision: 4,
      paginationOpts: { cursor: null, numItems: 30 },
    } satisfies FunctionArgs<typeof cloudApi.listMyAgentThreadsPage>;

    expect(args).toMatchObject({
      conversationId: "conversation-1",
      identityRevision: 4,
    });
  });

  test("allows create-time execution routing", () => {
    const args = {
      clientCreateId: "create-1",
      expectedOwnerGeneration: "owner-generation-1",
      execution: {
        engine: "openai-codex",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      },
    } satisfies FunctionArgs<typeof cloudApi.createMyConversation>;

    expect(args.execution.engine).toBe("openai-codex");
  });
});
