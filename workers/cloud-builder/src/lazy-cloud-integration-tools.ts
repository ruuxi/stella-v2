import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@stella/runtime/kernel/agent-core/types.js";
import {
  CLOUD_INTEGRATION_TOOL_SPECS,
  type CloudIntegrationToolName,
} from "./cloud-integration-tool-specs.js";
import type { CloudIntegrationToolContext } from "./cloud-integration-tools.js";

type CloudIntegrationTool = AgentTool & { codeEligibility: "read_only" };

const findTool = (
  tools: readonly CloudIntegrationTool[],
  name: CloudIntegrationToolName,
): CloudIntegrationTool => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Connected-tool implementation is missing ${name}.`);
  }
  return tool;
};

export const createLazyCloudIntegrationTools = (
  context: CloudIntegrationToolContext,
): CloudIntegrationTool[] => {
  let loaded: Promise<readonly CloudIntegrationTool[]> | null = null;
  const load = (): Promise<readonly CloudIntegrationTool[]> => {
    loaded ??= import("./cloud-integration-tools.js").then((module) =>
      module.createCloudIntegrationTools(context),
    );
    return loaded;
  };

  return CLOUD_INTEGRATION_TOOL_SPECS.map((spec) => ({
    ...spec,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> =>
      await findTool(await load(), spec.name).execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      ),
  }));
};
