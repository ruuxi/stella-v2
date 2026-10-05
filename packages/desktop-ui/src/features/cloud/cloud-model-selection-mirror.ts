import {
  DEFAULT_CODEX_MODEL,
  type CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import {
  buildEngineReasoningPatch,
  buildEngineRoutingPatch,
  buildEngineTransitionReasoningPatch,
  buildModelSelectionPatch,
  DEFAULT_CLAUDE_CODE_MODEL,
  type EngineReasoningEffort,
  type EngineReasoningPreferences,
  type EngineRoutingPreferences,
} from "@/global/settings/lib/engine-model-routing";

/**
 * The account's model selection lives on the server (`cloud_engine_settings`)
 * so every client picks from one list and one choice. The desktop runtime
 * still reads its local preferences, so these helpers translate between the
 * two shapes in both directions.
 */
export type MirroredModelPreferences = EngineRoutingPreferences &
  EngineReasoningPreferences;

const STELLA_DEFAULT_MODEL = "stella/default";
const CONVERSATION_AGENT_KEYS = ["orchestrator", "general"] as const;

const toLocalEffort = (
  effort: CloudExecutionSelection["reasoningEffort"],
): EngineReasoningEffort => (effort === "none" ? "default" : effort);

export const sameCloudExecution = (
  left: CloudExecutionSelection,
  right: CloudExecutionSelection,
): boolean =>
  left.engine === right.engine &&
  left.model === right.model &&
  // Managed Stella routes take their effort from the backend.
  (left.engine === "stella" || left.reasoningEffort === right.reasoningEffort);

/**
 * The server selection equivalent to the local preferences, or null when the
 * local choice has no server form (a bring-your-own-key provider model).
 */
export function cloudExecutionFromLocal(
  preferences: MirroredModelPreferences,
): CloudExecutionSelection | null {
  switch (preferences.agentRuntimeEngine) {
    case "claude_code_local":
      return {
        engine: "anthropic",
        provider: "anthropic",
        model: preferences.claudeCodeModel || DEFAULT_CLAUDE_CODE_MODEL,
        reasoningEffort: preferences.claudeCodeReasoningEffort,
      };
    case "codex_cli":
      return {
        engine: "chatgpt",
        provider: "chatgpt",
        model: preferences.codexModel || DEFAULT_CODEX_MODEL,
        reasoningEffort: preferences.codexReasoningEffort,
      };
    default: {
      const model =
        preferences.modelOverrides.general ??
        preferences.modelOverrides.orchestrator ??
        "";
      if (!model) {
        return {
          engine: "stella",
          provider: "stella",
          model: STELLA_DEFAULT_MODEL,
          reasoningEffort: "default",
        };
      }
      if (!model.startsWith("stella/")) return null;
      return {
        engine: "stella",
        provider: "stella",
        model,
        reasoningEffort: "default",
      };
    }
  }
}

/** The local preference write that applies a server selection. */
export function localPatchForCloudExecution(
  preferences: MirroredModelPreferences,
  execution: CloudExecutionSelection,
): Partial<MirroredModelPreferences> & { codexModelExplicit?: boolean } {
  if (execution.engine === "stella") {
    return buildModelSelectionPatch(
      preferences,
      execution.model === STELLA_DEFAULT_MODEL ? "" : execution.model,
      { assistant: true, configurableAgentKeys: [] },
    );
  }
  const engine =
    execution.engine === "anthropic" ? "claude_code_local" : "codex_cli";
  const routed = {
    ...buildEngineRoutingPatch(preferences, engine, execution.model),
    ...buildEngineTransitionReasoningPatch(preferences, engine),
  };
  return {
    ...routed,
    ...buildEngineReasoningPatch(
      { ...preferences, ...routed },
      engine,
      toLocalEffort(execution.reasoningEffort),
      CONVERSATION_AGENT_KEYS,
    ),
    ...(engine === "codex_cli" ? { codexModelExplicit: true } : {}),
  };
}
