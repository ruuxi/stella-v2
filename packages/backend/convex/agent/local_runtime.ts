import { ConvexError } from "convex/values";
import { action } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction, requireUserId } from "../auth";
import {
  AGENT_IDS,
  LOCAL_RUNTIME_BACKEND_TOOL_NAMES,
} from "../lib/agent_constants";
import { enforceActionRateLimit, RATE_STANDARD } from "../lib/rate_limits";
import { createBackendTools } from "../tools/backend";
import { jsonValueValidator } from "../shared_validators";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";

const DEFAULT_MAX_AGENT_DEPTH = 2;
const BACKEND_TOOL_TIMEOUT_MS = 90_000;
const ALLOWED_LOCAL_RUNTIME_BACKEND_TOOLS = new Set<string>(
  LOCAL_RUNTIME_BACKEND_TOOL_NAMES,
);

const toToolResultText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);

const executeBackendTool = async (
  ctx: Parameters<typeof createBackendTools>[0],
  args: {
    ownerId: string;
    ownerGeneration: string;
    conversationId?: Id<"conversations">;
    agentType?: string;
    signal: AbortSignal;
  },
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<string> => {
  if (!ALLOWED_LOCAL_RUNTIME_BACKEND_TOOLS.has(toolName)) {
    throw new ConvexError(`Tool ${toolName} is not allowed from local runtime`);
  }
  const tools = createBackendTools(ctx, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    conversationId: args.conversationId,
    agentType: args.agentType ?? AGENT_IDS.GENERAL,
    maxAgentDepth: DEFAULT_MAX_AGENT_DEPTH,
  }) as Record<
    string,
    {
      execute?: (
        input: Record<string, unknown>,
        options: { signal: AbortSignal },
      ) => Promise<unknown>;
    }
  >;

  const tool = tools[toolName];
  if (!tool?.execute) {
    throw new ConvexError(`${toolName} is unavailable`);
  }

  const output = await tool.execute(toolArgs, { signal: args.signal });
  return toToolResultText(output);
};

export const executeTool = action({
  args: {
    toolName: v.string(),
    toolArgs: v.optional(jsonValueValidator),
    conversationId: v.optional(v.id("conversations")),
    agentType: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
      ctx,
      ownerId,
    );
    await enforceActionRateLimit(
      ctx,
      "agent_local_runtime_execute_tool",
      ownerId,
      RATE_STANDARD,
      "Too many tool invocations. Please wait a moment and try again.",
    );
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }

    const toolArgs =
      args.toolArgs && typeof args.toolArgs === "object"
        ? (args.toolArgs as Record<string, unknown>)
        : {};

    return await executeBackendTool(
      ctx,
      {
        ownerId,
        ownerGeneration,
        conversationId: args.conversationId,
        agentType: args.agentType,
        signal: AbortSignal.timeout(BACKEND_TOOL_TIMEOUT_MS),
      },
      args.toolName,
      toolArgs,
    );
  },
});
