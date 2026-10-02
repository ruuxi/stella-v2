/**
 * The one validate → before_tool → execute → after_tool step every tool
 * call runs through, whether the model issued it directly or a tool
 * re-entered the dispatcher for it (`code` cells, `multi_tool_use_parallel`).
 * Without a shared step, nested calls skipped schema validation and the
 * extension hooks that top-level calls get.
 */

import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { Tool } from "../../ai/types.js";
import type { ToolContext, ToolResult } from "./types.js";

let toolValidationModule:
  | Promise<typeof import("../../ai/utils/validation.js")>
  | undefined;
// Same lazy load as the agent loop: AJV stays off the startup path.
const loadToolValidation = () =>
  (toolValidationModule ??= import("../../ai/utils/validation.js"));

export type ToolCallPipelineArgs = {
  toolName: string;
  args: Record<string, unknown>;
  context: ToolContext;
  hookEmitter?: Pick<HookEmitter, "emit">;
  /** Hook filter context; defaults to `context.agentType`. */
  agentType?: string;
  /**
   * JSON schema to validate (and coerce) `args` against. Omit only when the
   * caller already validated against the same schema — the agent loop does
   * for model-issued top-level calls.
   */
  parameters?: Record<string, unknown>;
  /** Compatibility shim run on the raw args before validation. */
  prepareArguments?: (args: unknown) => unknown;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
};

export const runToolCallPipeline = async (
  call: ToolCallPipelineArgs,
): Promise<ToolResult> => {
  let effectiveArgs = call.args;
  if (call.prepareArguments) {
    const prepared = call.prepareArguments(effectiveArgs);
    if (prepared && typeof prepared === "object" && !Array.isArray(prepared)) {
      effectiveArgs = prepared as Record<string, unknown>;
    }
  }
  if (call.parameters) {
    const { validateToolArguments } = await loadToolValidation();
    try {
      effectiveArgs = validateToolArguments(
        {
          name: call.toolName,
          description: "",
          parameters: call.parameters,
        } as unknown as Tool,
        {
          type: "toolCall",
          id: call.context.requestId ?? "",
          name: call.toolName,
          arguments: effectiveArgs,
        },
      ) as Record<string, unknown>;
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  const filter = {
    tool: call.toolName,
    ...((call.agentType ?? call.context.agentType)
      ? { agentType: call.agentType ?? call.context.agentType }
      : {}),
  };
  if (call.hookEmitter) {
    const hookResult = await call.hookEmitter.emit(
      "before_tool",
      { tool: call.toolName, args: effectiveArgs, context: call.context },
      filter,
    );
    if (hookResult?.cancel) {
      return {
        error: `Tool blocked: ${hookResult.reason ?? "blocked by hook"}`,
      };
    }
    if (hookResult?.args) {
      effectiveArgs = hookResult.args;
    }
  }

  let toolResult = await call.execute(effectiveArgs);

  if (call.hookEmitter) {
    const hookResult = await call.hookEmitter.emit(
      "after_tool",
      {
        tool: call.toolName,
        args: effectiveArgs,
        result: toolResult,
        context: call.context,
      },
      filter,
    );
    if (hookResult?.result) {
      toolResult = hookResult.result;
    }
  }

  return toolResult;
};
