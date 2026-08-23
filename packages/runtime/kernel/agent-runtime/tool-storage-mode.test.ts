import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../tools/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import {
  buildRuntimeToolContext,
  createPiTools,
  executeRuntimeToolCall,
} from "./tool-adapters.js";

const baseContextArgs = {
  toolCallId: "tool-1",
  runId: "run-1",
  conversationId: "conversation-1",
  agentType: "orchestrator",
  deviceId: "device-1",
};

describe("runtime tool conversation storage mode", () => {
  test("preserves cloud ownership and defaults legacy callers to local", () => {
    expect(
      buildRuntimeToolContext({
        ...baseContextArgs,
        storageMode: "cloud",
      }).storageMode,
    ).toBe("cloud");
    expect(buildRuntimeToolContext(baseContextArgs).storageMode).toBe("local");
  });

  test("threads cloud ownership through native Pi tools", async () => {
    const receivedContexts: ToolContext[] = [];
    const tools = createPiTools({
      ...baseContextArgs,
      storageMode: "cloud",
      toolsAllowlist: ["capture"],
      toolCatalog: [
        {
          name: "capture",
          description: "Capture the tool context.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      store: {} as RuntimeStore,
      toolExecutor: async (_name, _args, context) => {
        receivedContexts.push(context);
        return { result: "ok" };
      },
    });

    const capture = tools.find((tool) => tool.name === "capture");
    expect(capture).toBeDefined();
    await capture!.execute(
      "tool-1",
      {},
      new AbortController().signal,
      undefined,
    );
    expect(receivedContexts.at(-1)?.storageMode).toBe("cloud");
  });

  test("threads cloud ownership through the external-engine adapter", async () => {
    const receivedContexts: ToolContext[] = [];
    await executeRuntimeToolCall({
      ...baseContextArgs,
      storageMode: "cloud",
      toolName: "capture",
      args: {},
      store: {} as RuntimeStore,
      toolExecutor: async (_name, _args, context) => {
        receivedContexts.push(context);
        return { result: "ok" };
      },
    });
    expect(receivedContexts.at(-1)?.storageMode).toBe("cloud");
  });
});
