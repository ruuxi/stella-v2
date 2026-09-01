import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_SERVICE_TIER,
  type CodexServiceTier,
} from "@stella/contracts/agent-engine";
import { loadLocalPreferences } from "../preferences/local-preferences.js";

type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export const CODEX_LIGHT_MODEL = "gpt-5.4-mini";

const normalizeCodexReasoningEffort = (
  value: unknown,
): CodexReasoningEffort | undefined => {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
};

/**
 * Resolve the ChatGPT subscription model settings used by Stella's in-process
 * agent harness. Authentication and inference still go through the dedicated
 * openai-codex OAuth/Responses transport; no Codex executable is involved.
 */
export const getCodexSubscriptionPreferences = (
  stellaDataDir?: string,
  stellaModel?: string,
  modelOverride?: string,
): {
  model: string;
  reasoningEffort?: CodexReasoningEffort;
  serviceTier: CodexServiceTier;
} => {
  const prefs = stellaDataDir ? loadLocalPreferences(stellaDataDir) : null;
  const lightDefault =
    stellaModel?.trim() === "stella/light" ? CODEX_LIGHT_MODEL : undefined;
  const preferredModel = prefs?.codexModel;
  const userSelectedModel =
    prefs?.codexModelExplicit === true && preferredModel
      ? preferredModel
      : undefined;
  const model =
    modelOverride?.trim() ||
    process.env.STELLA_CODEX_MODEL?.trim() ||
    userSelectedModel ||
    lightDefault ||
    preferredModel ||
    DEFAULT_CODEX_MODEL;
  const envReasoning = normalizeCodexReasoningEffort(
    process.env.STELLA_CODEX_REASONING_EFFORT?.trim(),
  );
  const prefReasoning = prefs?.codexReasoningEffort;
  const reasoningEffort =
    envReasoning ??
    (prefReasoning && prefReasoning !== "default" ? prefReasoning : undefined);
  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    serviceTier: prefs?.codexServiceTier ?? DEFAULT_CODEX_SERVICE_TIER,
  };
};
