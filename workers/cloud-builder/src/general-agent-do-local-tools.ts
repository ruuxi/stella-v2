/**
 * The general-agent tools a resident turn executes itself.
 *
 * `web` is fetch-and-search, which the Durable Object can already do. Deploy
 * runs against worker-side capabilities the Durable Object already holds.
 */

import type { TSchema } from "@sinclair/typebox";
import type {
  AgentTool,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types.js";
import { AGENT_ORCHESTRATION_TOOL_DESCRIPTORS } from "@stella/runtime/kernel/tools/defs/agent-orchestration-def.js";
import { APPLY_PATCH_TOOL_NAME } from "@stella/runtime/kernel/tools/defs/apply-patch-def.js";
import { EDIT_TOOL_NAME } from "@stella/runtime/kernel/tools/defs/edit-def.js";
import { GREP_TOOL_NAME } from "@stella/runtime/kernel/tools/defs/grep-def.js";
import { READ_TOOL_NAME } from "@stella/runtime/kernel/tools/defs/read-def.js";
import { WRITE_TOOL_NAME } from "@stella/runtime/kernel/tools/defs/write-def.js";
import {
  WEB_TOOL_DESCRIPTION,
  WEB_TOOL_NAME,
  WEB_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/web-def.js";
import type { GeneralAgentControlPlane } from "./agent-control-plane.js";
import { descriptorForTool } from "./general-agent-tools.js";

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
  agentControl: GeneralAgentAgentControl;
  world: {
    tool(call: {
      name: "Read" | "Write" | "Edit" | "Grep" | "apply_patch";
      arguments: Record<string, unknown>;
    }): Promise<{ ok: boolean; output: string }>;
  };
  signal?: AbortSignal;
}): ReadonlyMap<string, AgentTool> => {
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
  const worldTools = [
    APPLY_PATCH_TOOL_NAME,
    READ_TOOL_NAME,
    WRITE_TOOL_NAME,
    EDIT_TOOL_NAME,
    GREP_TOOL_NAME,
  ] as const;
  return new Map<string, AgentTool>([
    ...worldTools.map((name): readonly [string, AgentTool] => {
      const descriptor = descriptorForTool(name);
      return [
        name,
        {
          name,
          label: descriptor.label,
          description: descriptor.description,
          parameters: descriptor.parameters as unknown as TSchema,
          execute: async (_toolCallId, params) => {
            const result = await deps.world.tool({
              name,
              arguments: (params ?? {}) as Record<string, unknown>,
            });
            return {
              content: [{ type: "text", text: result.output || "(no output)" }],
              details: null,
              ...(result.ok ? {} : { isError: true }),
            };
          },
        },
      ];
    }),
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
  ]);
};
