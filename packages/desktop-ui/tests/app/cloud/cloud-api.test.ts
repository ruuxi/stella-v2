import { describe, expect, test } from "vitest";
import { getFunctionName, type FunctionArgs } from "convex/server";
import { cloudApi } from "../../../src/features/cloud/cloud-api";

describe("cloud API references", () => {
  test("targets the restored canonical conversation functions", () => {
    expect(getFunctionName(cloudApi.getCloudRealtimeConfig)).toBe(
      "cloud_apps:getCloudRealtimeConfig",
    );
    expect(getFunctionName(cloudApi.startCloudChat)).toBe(
      "cloud_apps:startCloudChat",
    );
    expect(getFunctionName(cloudApi.listMyRecentAgentThreads)).toBe(
      "cloud_apps:listMyRecentAgentThreads",
    );
  });

  test("allows create-time execution routing", () => {
    const args = {
      clientCreateId: "create-1",
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
