import { ConvexError, v } from "convex/values";

export const CLOUD_EXECUTION_ENGINES = [
  "stella",
  "anthropic",
  "openai-codex",
] as const;

export type CloudExecutionEngine = (typeof CLOUD_EXECUTION_ENGINES)[number];

export const CLOUD_REASONING_EFFORTS = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type CloudReasoningEffort = (typeof CLOUD_REASONING_EFFORTS)[number];

type CloudExecutionSelectionBase = {
  model: string;
  reasoningEffort: CloudReasoningEffort;
};

export type CloudExecutionSelection = CloudExecutionSelectionBase & {
  engine: CloudExecutionEngine;
  provider: CloudExecutionEngine;
};

export type CloudExecutionSelectionInput = CloudExecutionSelection;

export const cloudExecutionSelectionValidator = v.object({
  engine: v.union(
    v.literal("stella"),
    v.literal("anthropic"),
    v.literal("openai-codex"),
  ),
  provider: v.union(
    v.literal("stella"),
    v.literal("anthropic"),
    v.literal("openai-codex"),
  ),
  model: v.string(),
  reasoningEffort: v.union(
    v.literal("default"),
    v.literal("none"),
    v.literal("minimal"),
    v.literal("low"),
    v.literal("medium"),
    v.literal("high"),
    v.literal("xhigh"),
  ),
});

export const DEFAULT_CLOUD_EXECUTION: CloudExecutionSelection = {
  engine: "stella",
  provider: "stella",
  // Keep the managed default opaque. The authenticated cloud-model endpoint
  // resolves this per agent and account audience, while the turn token binds
  // the request to this exact selection rather than a retired concrete model.
  model: "stella/default",
  reasoningEffort: "default",
};

export const DEFAULT_CLOUD_ANTHROPIC_EXECUTION: CloudExecutionSelection = {
  engine: "anthropic",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  reasoningEffort: "default",
};

export const DEFAULT_CLOUD_CODEX_EXECUTION: CloudExecutionSelection = {
  engine: "openai-codex",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "default",
};

const MANAGED_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const ENGINE_NATIVE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const ANTHROPIC_NATIVE_MODEL_ID =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,191}|[A-Za-z0-9][A-Za-z0-9._-]{0,187}\[1m\])$/;

/**
 * Convex validators enforce the literal shape; this enforces relationships
 * and canonical identifiers that cannot be represented by `v.object`.
 */
export const normalizeCloudExecutionSelection = (
  input: CloudExecutionSelectionInput,
): CloudExecutionSelection => {
  if (input.engine !== input.provider) {
    throw new ConvexError(
      "Cloud execution engine and provider must identify the same route.",
    );
  }
  const model = input.model.trim();
  if (input.engine === "stella" && !model.startsWith("stella/")) {
    throw new ConvexError(
      'The managed cloud engine requires a canonical "stella/..." model id.',
    );
  }
  if (input.engine !== "stella" && model.startsWith("stella/")) {
    throw new ConvexError(
      "Connected cloud engines require an engine-native model id.",
    );
  }
  const validModel =
    input.engine === "stella"
      ? MANAGED_MODEL_ID.test(model)
      : input.engine === "anthropic"
        ? ANTHROPIC_NATIVE_MODEL_ID.test(model)
        : ENGINE_NATIVE_MODEL_ID.test(model);
  if (!validModel) {
    throw new ConvexError(
      "Cloud execution model must be a canonical model id of 1–192 safe characters.",
    );
  }
  return { ...input, model };
};

export const defaultCloudExecutionForEngine = (
  engine: CloudExecutionEngine,
): CloudExecutionSelection => {
  if (engine === "anthropic") return DEFAULT_CLOUD_ANTHROPIC_EXECUTION;
  if (engine === "openai-codex") return DEFAULT_CLOUD_CODEX_EXECUTION;
  return DEFAULT_CLOUD_EXECUTION;
};
