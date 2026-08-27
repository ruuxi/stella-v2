import type { Id } from "../_generated/dataModel";
import { AGENT_IDS, BASE_BACKEND_TOOL_NAMES } from "../lib/agent_constants";

export type BackendToolExecuteResult = string;

export type BackendToolExecutionOptions = {
  /** Stable enclosing-run cancellation propagated into every external read. */
  signal: AbortSignal;
};

export type BackendToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  execute: (
    args: Record<string, unknown>,
    options: BackendToolExecutionOptions,
  ) => Promise<BackendToolExecuteResult>;
};

export type BackendToolSet = Record<string, BackendToolDefinition>;

type ToolOwnerScope =
  | {
      ownerId: string;
      ownerGeneration: string;
    }
  | {
      ownerId?: undefined;
      ownerGeneration?: undefined;
    };

export type ToolOptions = ToolOwnerScope & {
  agentType: string;
  toolsAllowlist?: string[];
  maxAgentDepth: number;
  conversationId?: Id<"conversations">;
  userMessageId?: Id<"events">;
  transient?: boolean;
};

/**
 * Reference list of all tool names across all tiers.
 * Not used for logic — only for documentation and type hints.
 */
export const BASE_TOOL_NAMES = [...BASE_BACKEND_TOOL_NAMES] as const;

export const DEFAULT_BACKEND_AGENT_TYPE = AGENT_IDS.GENERAL;
