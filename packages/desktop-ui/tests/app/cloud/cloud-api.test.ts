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
    expect(getFunctionName(cloudApi.getMyExecutionPlacementIdentity)).toBe(
      "execution_placement:getMyExecutionPlacementIdentity",
    );
    expect(getFunctionName(cloudApi.startCloudChat)).toBe(
      "cloud_apps:startCloudChat",
    );
    expect(getFunctionName(cloudApi.submitBrowserExecution)).toBe(
      "execution_placement:submitMyBrowserExecution",
    );
    expect(getFunctionName(cloudApi.getExecutionDispatchStatus)).toBe(
      "execution_placement:getMyExecutionDispatchStatus",
    );
    expect(getFunctionName(cloudApi.cancelExecutionDispatch)).toBe(
      "execution_placement:cancelMyExecutionDispatch",
    );
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
