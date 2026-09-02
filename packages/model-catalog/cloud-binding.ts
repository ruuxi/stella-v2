import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { ManagedGatewayProvider } from "./managed-gateway";

/**
 * The execution fields the binding validators read. Structurally satisfied
 * by a contracts `CloudExecutionSelection` and by Convex's persisted
 * turn-token row, whose `engine` and `provider` are typed independently.
 */
export type CloudExecutionBinding = {
  engine: CloudExecutionSelection["engine"];
  provider: CloudExecutionSelection["provider"];
  model: CloudExecutionSelection["model"];
  reasoningEffort: CloudExecutionSelection["reasoningEffort"];
};

export const LEGACY_CLOUD_EXECUTOR_MODEL = "stella/anthropic/claude-sonnet-4.6";

export type CloudBindingError = {
  status: 400 | 403;
  message: string;
};

export type ConnectedCloudRequestKind =
  | "anthropic_messages"
  | "anthropic_count_tokens"
  | "codex_responses"
  | "codex_compact";

export type ConnectedCloudBinding =
  | {
      ok: true;
      nativeModel: string;
      requestKind: ConnectedCloudRequestKind;
    }
  | { ok: false; error: CloudBindingError };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const cloudReasoningRank = (
  effort: CloudExecutionSelection["reasoningEffort"],
): number => {
  switch (effort) {
    case "none":
      return 0;
    case "minimal":
      return 1;
    case "low":
      return 2;
    case "default":
    case "medium":
      return 3;
    case "high":
      return 4;
    case "xhigh":
      return 5;
  }
};

const managedWireEffortRank = (args: {
  provider: ManagedGatewayProvider;
  source: "effort" | "google-level";
  value: string;
}): number | null => {
  const value = args.value.trim().toLowerCase();
  if (args.source === "google-level") {
    if (value === "low") return 1;
    if (value === "high") return 3;
  }
  if (value === "none" || value === "off" || value === "disabled") return 0;
  if (value === "minimal") return 1;
  if (value === "low") {
    // Anthropic adaptive, Gemini 3, and every DeepSeek relay collapse Stella's
    // minimal/low rungs to the same LOW wire value.
    return args.provider === "anthropic" ||
      args.provider === "google" ||
      args.provider === "deepseek" ||
      args.provider === "crof" ||
      args.provider === "wafer"
      ? 1
      : 2;
  }
  if (value === "medium") return 3;
  if (value === "high") {
    // DeepSeek maps Stella medium to native high; Gemini 3 maps medium/high
    // to HIGH. The wire value therefore represents the cheapest logical rung
    // that can produce it, which is the correct cost ceiling comparison.
    if (args.provider === "deepseek" || args.provider === "google") return 3;
    return 4;
  }
  if (value === "xhigh") return 5;
  if (value === "max") {
    // DeepSeek maps both high and xhigh to max.
    return args.provider === "deepseek" ? 4 : 5;
  }
  return null;
};

const budgetCeilingForManagedProvider = (args: {
  provider: ManagedGatewayProvider;
  selectedRank: number;
  resolvedModel: string;
}): number | null => {
  if (args.provider === "anthropic") {
    return [0, 1_024, 2_048, 8_192, 16_384, 16_384][args.selectedRank] ?? null;
  }
  if (args.provider === "google") {
    const model = args.resolvedModel.toLowerCase();
    const minimal = model.includes("2.5-flash-lite") ? 512 : 128;
    const high = model.includes("2.5-pro") ? 32_768 : 24_576;
    if (model.includes("2.5-pro") || model.includes("2.5-flash")) {
      return [0, minimal, 2_048, 8_192, high, high][args.selectedRank] ?? null;
    }
    // Other budget-based Gemini models use Google's `-1` auto sentinel.
    return -1;
  }
  return null;
};

const managedReasoningFloorRank = (args: {
  provider: ManagedGatewayProvider;
  resolvedModel: string;
}): number => {
  const model = args.resolvedModel.toLowerCase();
  if (args.provider === "google" && /gemini-3(?:\.\d+)?-pro/u.test(model)) {
    return 1;
  }
  if (/gemini-3(?:\.\d+)?-flash/u.test(model) || /gemma-?4/u.test(model)) {
    return 1;
  }
  // These catalog entries cannot express thinking-off. The runtime clamps a
  // lower logical selection to the cheapest supported wire tier using its
  // thinkingLevelMap; mirror those exact current floors here so the relay does
  // not mistake a required clamp for an escalation.
  if (/(?:^|\/)grok-4\.5(?:[-.]|$)/u.test(model)) return 2;
  if (/(?:^|\/)muse-spark-1\.2-contributor(?:[-.]|$)/u.test(model)) return 2;
  return 0;
};

const isManagedModelFloor = (args: {
  provider: ManagedGatewayProvider;
  resolvedModel: string;
  source: "effort" | "google-level";
  candidateRank: number;
  selectedRank: number;
}): boolean => {
  const floor = managedReasoningFloorRank(args);
  if (
    floor === 0 ||
    args.selectedRank >= floor ||
    args.candidateRank !== floor
  ) {
    return false;
  }
  return args.provider === "google"
    ? args.source === "google-level"
    : args.source === "effort";
};

/**
 * Treat a turn's selected reasoning effort as a maximum compute tier. Runtime
 * adapters legitimately clamp or collapse tiers (DeepSeek/Crof, Gemini,
 * legacy Claude budgets), so the relay validates canonical wire forms at or
 * below the selection instead of requiring one spelling everywhere.
 */
export const validateManagedReasoningBinding = (args: {
  execution: CloudExecutionBinding;
  relayProvider: ManagedGatewayProvider;
  resolvedModel: string;
  reasoningCapable: boolean;
  requestJson: Record<string, unknown>;
}): CloudBindingError | null => {
  const reasoning = asRecord(args.requestJson.reasoning);
  const outputConfig = asRecord(args.requestJson.output_config);
  const thinking = asRecord(args.requestJson.thinking);
  const generationConfig =
    asRecord(args.requestJson.generationConfig) ??
    asRecord(args.requestJson.generation_config);
  const thinkingConfig =
    asRecord(generationConfig?.thinkingConfig) ??
    asRecord(generationConfig?.thinking_config);

  const effortCandidates = [
    { source: "effort" as const, value: reasoning?.effort },
    { source: "effort" as const, value: args.requestJson.reasoning_effort },
    { source: "effort" as const, value: outputConfig?.effort },
    {
      source: "google-level" as const,
      value: thinkingConfig?.thinkingLevel,
    },
    {
      source: "google-level" as const,
      value: thinkingConfig?.thinking_level,
    },
  ].filter((candidate) => candidate.value !== undefined);
  if (effortCandidates.some(({ value }) => typeof value !== "string")) {
    return {
      status: 400,
      message: "Managed reasoning effort must be a canonical string",
    };
  }

  const selectedRank = cloudReasoningRank(args.execution.reasoningEffort);
  const effortRanks = effortCandidates.map(({ source, value }) =>
    managedWireEffortRank({
      provider: args.relayProvider,
      source,
      value: value as string,
    }),
  );
  if (effortRanks.some((rank) => rank === null)) {
    return {
      status: 400,
      message: "Managed reasoning effort is not a canonical wire value",
    };
  }
  if (
    effortCandidates.some(
      (candidate, index) =>
        (effortRanks[index] as number) > selectedRank &&
        !isManagedModelFloor({
          provider: args.relayProvider,
          resolvedModel: args.resolvedModel,
          source: candidate.source,
          candidateRank: effortRanks[index] as number,
          selectedRank,
        }),
    )
  ) {
    return {
      status: 403,
      message:
        "This turn token is not authorized for the requested reasoning effort",
    };
  }

  const budgets = [
    thinking?.budget_tokens,
    thinking?.budgetTokens,
    thinkingConfig?.thinkingBudget,
    thinkingConfig?.thinking_budget,
  ].filter((value) => value !== undefined);
  const allowsGoogleAutoBudget =
    args.relayProvider === "google" &&
    !args.resolvedModel.toLowerCase().includes("2.5-pro") &&
    !args.resolvedModel.toLowerCase().includes("2.5-flash");
  if (
    budgets.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (value < 0 && !(allowsGoogleAutoBudget && value === -1)),
    )
  ) {
    return { status: 400, message: "Managed reasoning budget is invalid" };
  }
  const budgetCeiling = budgetCeilingForManagedProvider({
    provider: args.relayProvider,
    selectedRank,
    resolvedModel: args.resolvedModel,
  });
  if (
    budgets.length > 0 &&
    (budgetCeiling === null ||
      (budgetCeiling === -1
        ? budgets.some(
            (value) => value !== 0 && !(selectedRank > 0 && value === -1),
          )
        : budgets.some((value) => (value as number) > budgetCeiling)))
  ) {
    return {
      status: 403,
      message:
        "This turn token is not authorized for the requested reasoning budget",
    };
  }

  const thinkingType =
    typeof thinking?.type === "string"
      ? thinking.type.trim().toLowerCase()
      : undefined;
  const thinkingDisabled =
    thinkingType === "disabled" || thinkingType === "none";
  const thinkingEnabled =
    thinkingType === "enabled" || thinkingType === "adaptive";

  if (selectedRank === 0 && thinkingEnabled) {
    return {
      status: 403,
      message:
        "This turn token is not authorized for the requested thinking mode",
    };
  }
  const hasReasoningControl =
    reasoning !== null ||
    args.requestJson.reasoning_effort !== undefined ||
    outputConfig !== null ||
    thinking !== null ||
    thinkingConfig !== null;
  if (
    hasReasoningControl &&
    effortRanks.length === 0 &&
    budgets.length === 0 &&
    !thinkingDisabled
  ) {
    return {
      status: 403,
      message: "Managed reasoning controls require a bounded compute tier",
    };
  }
  const missingEffortWouldEscalate =
    args.relayProvider === "deepseek" ||
    args.relayProvider === "crof" ||
    args.relayProvider === "wafer";
  if (
    args.reasoningCapable &&
    (selectedRank > 0 || missingEffortWouldEscalate) &&
    effortRanks.length === 0 &&
    budgets.length === 0 &&
    !thinkingDisabled
  ) {
    return {
      status: 403,
      message: "This turn token requires the selected managed reasoning effort",
    };
  }
  return null;
};

const connectedRequestKind = (
  credentialProvider: "anthropic" | "openai-codex",
  pathname: string,
): ConnectedCloudRequestKind | null => {
  if (credentialProvider === "anthropic") {
    if (pathname.endsWith("/v1/messages/count_tokens")) {
      return "anthropic_count_tokens";
    }
    return pathname.endsWith("/v1/messages") ? "anthropic_messages" : null;
  }
  if (
    pathname.endsWith("/responses/compact") ||
    pathname.endsWith("/v1/responses/compact")
  ) {
    return "codex_compact";
  }
  return pathname.endsWith("/responses") || pathname.endsWith("/v1/responses")
    ? "codex_responses"
    : null;
};

const nativeRequestedModel = (
  provider: "anthropic" | "openai-codex",
  requestedModel: string,
): string | null => {
  const wrappedPrefix = `stella/${provider}/`;
  const nativeModel = requestedModel.startsWith(wrappedPrefix)
    ? requestedModel.slice(wrappedPrefix.length)
    : requestedModel;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(nativeModel)
    ? nativeModel
    : null;
};

const anthropicModelMatchesSelection = (args: {
  selectedModel: string;
  nativeModel: string;
  anthropicBeta?: string;
}): boolean => {
  const selected = args.selectedModel.toLowerCase();
  const native = args.nativeModel.toLowerCase();
  if (selected === native) return true;

  const needsOneMillionContext = selected.endsWith("[1m]");
  const alias = needsOneMillionContext ? selected.slice(0, -4) : selected;
  if (
    needsOneMillionContext &&
    !args.anthropicBeta
      ?.split(",")
      .some((value) => value.trim().startsWith("context-1m-"))
  ) {
    return false;
  }
  if (alias === native) return true;

  const family = (["opus", "sonnet", "haiku", "fable", "mythos"] as const).find(
    (candidate) => native.includes(`-${candidate}-`),
  );
  if (!family || !native.startsWith("claude-")) return false;
  if (alias === family) return true;
  if (alias === "opusplan") return family === "opus" || family === "sonnet";
  if (alias === "best") {
    return family === "opus" || family === "fable" || family === "mythos";
  }
  // `default` deliberately delegates the exact version/family resolution to
  // the authenticated Claude CLI and the owner's current subscription. Keep
  // the wildcard bounded to recognized first-party Claude model families.
  return alias === "default";
};

const expectedNativeEfforts = (
  execution: CloudExecutionBinding,
): ReadonlySet<string> => {
  if (execution.engine === "anthropic") {
    if (execution.reasoningEffort === "none") return new Set();
    if (execution.reasoningEffort === "default") return new Set();
    if (execution.reasoningEffort === "minimal") return new Set(["low"]);
    if (execution.reasoningEffort === "xhigh") {
      return new Set(["xhigh", "max"]);
    }
  } else {
    if (execution.reasoningEffort === "default") return new Set();
    if (execution.reasoningEffort === "none") return new Set(["none", "off"]);
  }
  return new Set([execution.reasoningEffort]);
};

const CLAUDE_FAMILY_VERSION_PATTERN =
  /claude[-.]([a-z]+)[-.](\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/u;

const claudeCapabilities = (model: string) => {
  const match = CLAUDE_FAMILY_VERSION_PATTERN.exec(model.toLowerCase());
  if (!match) return { adaptive: false, canDisable: true };
  const family = match[1];
  const major = Number(match[2]);
  const minor = match[3] === undefined ? 0 : Number(match[3]);
  return {
    adaptive:
      major >= 5 ||
      ((family === "opus" || family === "sonnet") && major === 4 && minor >= 6),
    canDisable: family !== "fable",
  };
};

const legacyAnthropicBudgetCeiling = (
  effort: CloudExecutionSelection["reasoningEffort"],
): number => {
  switch (effort) {
    case "minimal":
      return 1_024;
    case "low":
      return 2_048;
    case "default":
    case "medium":
      return 8_192;
    case "high":
    case "xhigh":
      return 16_384;
    case "none":
      return 0;
  }
};

const validateNativeReasoning = (args: {
  execution: CloudExecutionBinding;
  nativeModel: string;
  requestKind: ConnectedCloudRequestKind;
  requestJson: Record<string, unknown>;
}): CloudBindingError | null => {
  // Count-token requests do not perform inference and carry no thinking
  // controls. Their model is still bound to the turn below.
  if (args.requestKind === "anthropic_count_tokens") return null;
  // Connected subscription defaults belong to the native CLI/runtime. Stella
  // is neither paying for nor pinning that account's provider-side tier.
  if (args.execution.reasoningEffort === "default") return null;

  const expectedEfforts = expectedNativeEfforts(args.execution);
  if (args.execution.engine === "anthropic") {
    const outputConfig = asRecord(args.requestJson.output_config);
    const thinking = asRecord(args.requestJson.thinking);
    const thinkingType = thinking?.type;
    const capabilities = claudeCapabilities(args.nativeModel);

    if (args.execution.reasoningEffort === "none") {
      // Claude CLI may represent `--thinking disabled` by omitting the
      // request field entirely. An explicit disabled shape is also valid on
      // models that support it; adaptive/enabled remains forbidden.
      const validDisabledShape =
        thinking === null ||
        (capabilities.canDisable && thinkingType === "disabled");
      if (!validDisabledShape || outputConfig?.effort !== undefined) {
        return {
          status: 403,
          message:
            "This turn token is not authorized for the requested thinking mode",
        };
      }
      return null;
    }

    if (capabilities.adaptive) {
      if (
        thinkingType !== "adaptive" ||
        typeof outputConfig?.effort !== "string" ||
        !expectedEfforts.has(outputConfig.effort.trim().toLowerCase())
      ) {
        return {
          status: 403,
          message:
            "This turn token is not authorized for the requested reasoning effort",
        };
      }
      return null;
    }

    const budget = thinking?.budget_tokens;
    if (
      thinkingType !== "enabled" ||
      typeof budget !== "number" ||
      !Number.isFinite(budget) ||
      budget <= 0 ||
      budget > legacyAnthropicBudgetCeiling(args.execution.reasoningEffort) ||
      outputConfig?.effort !== undefined
    ) {
      return {
        status: 403,
        message:
          "This turn token is not authorized for the requested reasoning budget",
      };
    }
    return null;
  }

  const effort = asRecord(args.requestJson.reasoning)?.effort;
  if (
    typeof effort !== "string" ||
    !expectedEfforts.has(effort.trim().toLowerCase())
  ) {
    return {
      status: 403,
      message:
        "This turn token is not authorized for the requested reasoning effort",
    };
  }
  return null;
};

/**
 * Bind an engine-credential relay request to the immutable route stored with
 * its turn token. This is deliberately pure so the authorization invariant can
 * be tested without constructing a Convex action context.
 */
export const validateConnectedCloudBinding = (args: {
  execution?: CloudExecutionBinding;
  credentialProvider: "anthropic" | "openai-codex";
  requestedModel: string;
  requestPathname: string;
  requestJson: Record<string, unknown>;
  anthropicBeta?: string;
}): ConnectedCloudBinding => {
  if (!args.execution) {
    return {
      ok: false,
      error: {
        status: 403,
        message:
          "This turn token predates connected-engine route authorization. Start a new cloud turn.",
      },
    };
  }
  if (
    args.execution.engine !== args.credentialProvider ||
    args.execution.provider !== args.credentialProvider
  ) {
    return {
      ok: false,
      error: {
        status: 403,
        message:
          "This turn token is not authorized for the requested connected engine",
      },
    };
  }
  const requestKind = connectedRequestKind(
    args.credentialProvider,
    args.requestPathname,
  );
  if (!requestKind) {
    return {
      ok: false,
      error: {
        status: 400,
        message:
          args.credentialProvider === "anthropic"
            ? "Claude cloud turns may call only the native Messages API"
            : "Codex cloud turns may call only the native Responses API",
      },
    };
  }
  const nativeModel = nativeRequestedModel(
    args.credentialProvider,
    args.requestedModel,
  );
  if (!nativeModel) {
    return {
      ok: false,
      error: {
        status: 400,
        message: "Engine-credential turns must send an engine-native model id",
      },
    };
  }
  const modelMatches =
    args.credentialProvider === "anthropic"
      ? anthropicModelMatchesSelection({
          selectedModel: args.execution.model,
          nativeModel,
          anthropicBeta: args.anthropicBeta,
        })
      : args.execution.model === nativeModel;
  if (!modelMatches) {
    return {
      ok: false,
      error: {
        status: 403,
        message: "This turn token is not authorized for the requested model",
      },
    };
  }
  const reasoningError = validateNativeReasoning({
    execution: args.execution,
    nativeModel,
    requestKind,
    requestJson: args.requestJson,
  });
  if (reasoningError) return { ok: false, error: reasoningError };
  return { ok: true, nativeModel, requestKind };
};

export const validateManagedCloudBinding = (args: {
  execution?: CloudExecutionBinding;
  viaTurnToken: boolean;
  requestedModel: unknown;
}): CloudBindingError | null => {
  if (
    args.execution?.engine === "stella" &&
    args.requestedModel !== args.execution.model
  ) {
    return {
      status: 403,
      message:
        "This turn token is not authorized for the requested managed model",
    };
  }
  if (
    args.viaTurnToken &&
    !args.execution &&
    args.requestedModel !== LEGACY_CLOUD_EXECUTOR_MODEL
  ) {
    return {
      status: 403,
      message:
        "This legacy turn token is authorized only for the original cloud model",
    };
  }
  return null;
};
