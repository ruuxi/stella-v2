import {
  isRestrictedAudienceAllowedStellaModelId,
  isRestrictedModelOverrideAudience,
  type ManagedModelAudience,
} from "@/global/billing/audience";

export type NoticeRuntimeEngine = "default" | "claude_code_local" | "codex_cli";

const ORCHESTRATOR_AND_GENERAL = ["orchestrator", "general"] as const;

export type TierRestrictedModelNotice = {
  agent: (typeof ORCHESTRATOR_AND_GENERAL)[number];
  model: string;
  modelLabel: string;
};

const getModelToastLabel = (model: string): string => {
  const withoutStellaPrefix = model.startsWith("stella/")
    ? model.slice("stella/".length)
    : model;
  const lastSlash = withoutStellaPrefix.lastIndexOf("/");
  const displayId =
    lastSlash >= 0
      ? withoutStellaPrefix.slice(lastSlash + 1)
      : withoutStellaPrefix;
  return displayId || "That model";
};

export const resolveTierRestrictedModelNotice = (args: {
  audience: ManagedModelAudience | null | undefined;
  agentRuntimeEngine: NoticeRuntimeEngine | undefined;
  modelOverrides: Record<string, string> | undefined;
}): TierRestrictedModelNotice | null => {
  const audience = args.audience;
  if (!audience || !isRestrictedModelOverrideAudience(audience)) return null;
  if ((args.agentRuntimeEngine ?? "default") !== "default") return null;

  const overrides = args.modelOverrides ?? {};
  for (const agent of ORCHESTRATOR_AND_GENERAL) {
    const override = overrides[agent]?.trim();
    if (!override) continue;

    if (!override.startsWith("stella/")) continue;

    if (override === "stella/default") continue;
    if (isRestrictedAudienceAllowedStellaModelId(override)) continue;

    return { agent, model: override, modelLabel: getModelToastLabel(override) };
  }
  return null;
};
