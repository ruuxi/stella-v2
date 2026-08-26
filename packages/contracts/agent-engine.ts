export type AgentRuntimeEngine = "default" | "claude_code_local" | "codex_cli";

export const DEFAULT_AGENT_RUNTIME_ENGINE: AgentRuntimeEngine = "default";
/** Saved Codex/ChatGPT model preference. Kept even when not in the live catalog. */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
/** ChatGPT/Codex service tier selected in Stella's model picker. */
export type CodexServiceTier = "standard" | "fast";
export const DEFAULT_CODEX_SERVICE_TIER: CodexServiceTier = "standard";

/** Reasoning levels accepted by spawn_agent's optional model suffix. */
export type SpawnReasoningEffort = "low" | "medium" | "high" | "xhigh";

/** Effective reasoning setting captured from a running agent turn. */
export type AgentModelReasoningEffort =
  | "default"
  | "none"
  | "minimal"
  | SpawnReasoningEffort;

/**
 * Serializable snapshot of the effective model configuration for a turn.
 * Child threads persist this so every resume uses the spawning parent's
 * engine/model instead of resolving an independent default.
 */
export type AgentModelConfigSnapshot = {
  engine: AgentRuntimeEngine;
  /**
   * True when this durable General/subagent tree uses Stella's managed
   * subscription harness instead of the engine's native execution boundary.
   * False is an explicitly sampled native opt-out; absent retains the
   * backward-compatible native meaning of legacy persisted snapshots.
   */
  subscriptionHarnessEnabled?: boolean;
  /** Exact in-process route used for model metadata and native execution. */
  routeModel: string;
  /** Exact engine-native model when an external engine owns execution. */
  engineModel?: string;
  reasoningEffort?: AgentModelReasoningEffort;
  /** Effective ChatGPT/Codex service tier captured for this turn. */
  serviceTier?: CodexServiceTier;
  /**
   * The engine was selected explicitly by spawn_agent rather than inherited
   * from preferences. This preserves execution-profile semantics such as
   * vanilla Claude Code after worker/app restart.
   */
  executionProfile?: "spawn_override";
};

export const AGENT_RUNTIME_ENGINES: readonly AgentRuntimeEngine[] = [
  "default",
  "claude_code_local",
  "codex_cli",
];

const AGENT_RUNTIME_ENGINE_LABELS: Record<AgentRuntimeEngine, string> = {
  default: "Stella",
  claude_code_local: "Claude Code",
  codex_cli: "Codex",
};

/**
 * Per-spawn engine selection carried by spawn_agent's optional `model`
 * parameter. `stella` and plain model references explicitly select `default`
 * (the in-process Stella runtime); `codex[/<model>]` and
 * `claude-code[/<model>]` select an external engine. Scoped to a single
 * spawned agent run — never persisted to preferences.
 */
export type SpawnEngineSelection =
  | { engine: "default"; model?: never }
  | {
      engine: Exclude<AgentRuntimeEngine, "default">;
      /** Engine-native model id pinned for this run (e.g. `gpt-5.4-codex`, `opus`). */
      model?: string;
    };

export const isAgentRuntimeEngine = (
  value: unknown,
): value is AgentRuntimeEngine =>
  typeof value === "string" &&
  (AGENT_RUNTIME_ENGINES as readonly string[]).includes(value);

export const coerceAgentRuntimeEngine = (value: unknown): AgentRuntimeEngine =>
  isAgentRuntimeEngine(value) ? value : DEFAULT_AGENT_RUNTIME_ENGINE;

export const getAgentRuntimeEngineLabel = (
  engine: AgentRuntimeEngine,
): string => AGENT_RUNTIME_ENGINE_LABELS[engine];
