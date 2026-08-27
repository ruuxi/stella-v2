import type { AgentRuntimeEngine } from "@stella/contracts/agent-engine";
import type { ResolvedLlmRoute } from "../model-routing.js";

export const RECALL_STELLA_MODEL = "stella/deepseek/deepseek-v4-flash";

export const RECALL_CLAUDE_CODE_MODEL = "haiku";

export const RECALL_CODEX_PROVIDER_MODEL = "openai-codex/gpt-5.6-luna";

export type RecallModelRoute = {
  activeEngine: AgentRuntimeEngine;
  executionEngine: "claude-code" | "native";

  modelId: string;

  resolvedLlm?: ResolvedLlmRoute;

  claudeCodeModel?: string;
};
