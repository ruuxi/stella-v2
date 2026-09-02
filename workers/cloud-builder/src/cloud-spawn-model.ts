import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";

/**
 * The orchestrator's `spawn_agent` model override, resolved inside the
 * Durable Object that admits the spawn. The grammar and the defaults mirror
 * `packages/backend/convex/lib/cloud_execution.ts` exactly: "claude[/model]"
 * selects the connected Anthropic subscription, "codex[/model]" the
 * connected ChatGPT one, "stella/..." a managed route, and a trailing
 * ":effort" pins the reasoning effort. Whether a connected engine is actually
 * connected is the owner snapshot's call, checked by the caller.
 */

const CLOUD_SPAWN_MODEL =
  /^(?:claude(?:\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,191}|[A-Za-z0-9][A-Za-z0-9._-]{0,187}\[1m\]))?|codex(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,191})?|stella\/[A-Za-z0-9._:/-]{1,185})(?::(?:low|medium|high|xhigh))?$/;

export const isValidCloudSpawnModel = (model: string): boolean =>
  CLOUD_SPAWN_MODEL.test(model);

export const CLOUD_SPAWN_MODEL_HELP =
  'Cloud spawn model must be "claude[/model]", "codex[/model]", or a canonical "stella/..." model, optionally followed by :low, :medium, :high, or :xhigh.';

const DEFAULT_CLOUD_ANTHROPIC_EXECUTION: CloudExecutionSelection = {
  engine: "anthropic",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  reasoningEffort: "default",
};

const DEFAULT_CLOUD_CODEX_EXECUTION: CloudExecutionSelection = {
  engine: "openai-codex",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "default",
};

type SpawnEffort = "low" | "medium" | "high" | "xhigh";

/**
 * The execution a spawned agent runs with. No override (or "default")
 * inherits `inherited` exactly — the parent's execution for a fresh spawn,
 * the thread's own for a continuation.
 */
export const resolveCloudSpawnExecution = (
  model: string | undefined,
  inherited: CloudExecutionSelection,
): CloudExecutionSelection => {
  const trimmed = model?.trim() ?? "";
  if (!trimmed || trimmed === "default") return inherited;
  if (!isValidCloudSpawnModel(trimmed)) throw new Error(CLOUD_SPAWN_MODEL_HELP);
  const effortMatch = /:(low|medium|high|xhigh)$/.exec(trimmed);
  const reasoningEffort: CloudExecutionSelection["reasoningEffort"] =
    (effortMatch?.[1] as SpawnEffort | undefined) ?? "default";
  const route = effortMatch
    ? trimmed.slice(0, -effortMatch[0].length)
    : trimmed;
  if (route === "claude") {
    return { ...DEFAULT_CLOUD_ANTHROPIC_EXECUTION, reasoningEffort };
  }
  if (route.startsWith("claude/")) {
    return {
      ...DEFAULT_CLOUD_ANTHROPIC_EXECUTION,
      model: route.slice("claude/".length),
      reasoningEffort,
    };
  }
  if (route === "codex") {
    return { ...DEFAULT_CLOUD_CODEX_EXECUTION, reasoningEffort };
  }
  if (route.startsWith("codex/")) {
    return {
      ...DEFAULT_CLOUD_CODEX_EXECUTION,
      model: route.slice("codex/".length),
      reasoningEffort,
    };
  }
  return {
    engine: "stella",
    provider: "stella",
    model: route,
    reasoningEffort,
  };
};
