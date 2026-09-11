import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";

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
