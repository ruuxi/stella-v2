export type AgentRuntimeEngine = "default" | "claude_code_local" | "codex_cli";

export const DEFAULT_AGENT_RUNTIME_ENGINE: AgentRuntimeEngine = "default";

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

export type CodexServiceTier = "standard" | "fast";
export const DEFAULT_CODEX_SERVICE_TIER: CodexServiceTier = "standard";

export type SpawnReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type AgentModelReasoningEffort =
  | "none"
  | "minimal"
  | SpawnReasoningEffort;

export type AgentModelConfigSnapshot = {
  engine: AgentRuntimeEngine;

  subscriptionHarnessEnabled?: boolean;

  routeModel: string;

  engineModel?: string;
  reasoningEffort?: AgentModelReasoningEffort;

  serviceTier?: CodexServiceTier;
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

export type SpawnEngineSelection =
  | { engine: "default"; model?: never }
  | {
      engine: Exclude<AgentRuntimeEngine, "default">;

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
