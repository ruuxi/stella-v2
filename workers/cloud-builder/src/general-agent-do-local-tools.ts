/**
 * The general-agent tools a resident turn executes itself.
 *
 * `web` is fetch-and-search, which the Durable Object can already do. Deploy
 * is a request rather than an action in both placements: the container path
 * posts a turn-broker command, and here the same record is written straight to
 * DO storage. The ladder is told too, because a resident turn that asked for
 * the build has to attach after the loop or the tool would be a no-op the
 * model believes worked.
 */

import type { TSchema } from "@sinclair/typebox";
import type {
  AgentTool,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types.js";
import { AGENT_ORCHESTRATION_TOOL_DESCRIPTORS } from "@stella/runtime/kernel/tools/defs/agent-orchestration-def.js";
import {
  WEB_TOOL_DESCRIPTION,
  WEB_TOOL_NAME,
  WEB_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/web-def.js";
import type { GeneralAgentControlPlane } from "./agent-control-plane.js";
import {
  descriptorForTool,
  PUBLISH_STELLA_INTERIOR_TOOL_NAME,
} from "./general-agent-tools.js";
import { parseInteriorBuildRequest } from "./interior-build-request.js";

const errorResult = (message: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: message }],
  details: null,
  isError: true,
});

export type GeneralAgentAgentControl = Readonly<{
  execute(
    toolName: string,
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>>;
}>;

export const createGeneralAgentDoLocalTools = (deps: {
  control: GeneralAgentControlPlane;
  requestInteriorBuild: () => void;
  now: () => number;
  agentControl: GeneralAgentAgentControl;
  signal?: AbortSignal;
}): ReadonlyMap<string, AgentTool> => {
  const interior = descriptorForTool(PUBLISH_STELLA_INTERIOR_TOOL_NAME);
  const orchestration = AGENT_ORCHESTRATION_TOOL_DESCRIPTORS.map(
    (descriptor): readonly [string, AgentTool] => [
      descriptor.name,
      {
        name: descriptor.name,
        label: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.parameters as unknown as TSchema,
        execute: async (toolCallId, params, signal) =>
          deps.agentControl.execute(
            descriptor.name,
            toolCallId,
            (params ?? {}) as Record<string, unknown>,
            signal ?? deps.signal,
          ),
      },
    ],
  );
  return new Map<string, AgentTool>([
    [
      WEB_TOOL_NAME,
      {
        name: WEB_TOOL_NAME,
        label: WEB_TOOL_NAME,
        description: WEB_TOOL_DESCRIPTION,
        parameters: WEB_TOOL_PARAMETERS as unknown as TSchema,
        execute: async (_toolCallId, params) => {
          try {
            return await deps.control.web(
              (params ?? {}) as Record<string, never>,
              deps.signal,
            );
          } catch (error) {
            return errorResult(
              error instanceof Error ? error.message : "The web tool failed.",
            );
          }
        },
      },
    ],
    ...orchestration,
    [
      PUBLISH_STELLA_INTERIOR_TOOL_NAME,
      {
        name: interior.name,
        label: interior.label,
        ...(interior.workingText ? { workingText: interior.workingText } : {}),
        description: interior.description,
        parameters: interior.parameters as unknown as TSchema,
        execute: async (_toolCallId, params) => {
          const request = parseInteriorBuildRequest({
            schemaVersion: 1,
            ...((params ?? {}) as Record<string, unknown>),
          });
          if (!request) {
            return errorResult(
              "That build note could not be recorded. Keep it to one short line of plain text.",
            );
          }
          try {
            await deps.control.recordInteriorBuildRequest(request, deps.now());
          } catch {
            return errorResult(
              "Stella could not record the build request. Try again.",
            );
          }
          deps.requestInteriorBuild();
          return {
            content: [
              {
                type: "text",
                text: "Recorded. Stella will run the immutable interior build after this turn finishes and record the result as a candidate the user can select in Settings.",
              },
            ],
            details: null,
          };
        },
      },
    ],
  ]);
};
