import type { CloudExecutionSelection } from "../lib/cloud_execution";

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

const expectedNativeEffort = (
  execution: CloudExecutionSelection,
): string | null => {
  if (execution.engine === "anthropic") {
    if (
      execution.reasoningEffort === "default" ||
      execution.reasoningEffort === "none"
    ) {
      return null;
    }
    if (execution.reasoningEffort === "minimal") return "low";
    if (execution.reasoningEffort === "xhigh") return "max";
  } else if (execution.reasoningEffort === "default") {
    return null;
  }
  return execution.reasoningEffort;
};

const validateNativeReasoning = (args: {
  execution: CloudExecutionSelection;
  requestKind: ConnectedCloudRequestKind;
  requestJson: Record<string, unknown>;
}): CloudBindingError | null => {
  // Count-token requests do not perform inference and carry no thinking
  // controls. Their model is still bound to the turn below.
  if (args.requestKind === "anthropic_count_tokens") return null;

  const expectedEffort = expectedNativeEffort(args.execution);
  if (args.execution.reasoningEffort === "default") return null;
  if (args.execution.engine === "anthropic") {
    const outputConfig = asRecord(args.requestJson.output_config);
    if (
      args.execution.reasoningEffort === "none"
        ? outputConfig?.effort !== undefined
        : outputConfig?.effort !== expectedEffort
    ) {
      return {
        status: 403,
        message:
          "This turn token is not authorized for the requested reasoning effort",
      };
    }
    const thinkingType = asRecord(args.requestJson.thinking)?.type;
    const thinkingEnabled =
      thinkingType === "adaptive" || thinkingType === "enabled";
    if (
      (args.execution.reasoningEffort === "none" && thinkingEnabled) ||
      (args.execution.reasoningEffort !== "none" && !thinkingEnabled)
    ) {
      return {
        status: 403,
        message:
          "This turn token is not authorized for the requested thinking mode",
      };
    }
    return null;
  }

  if (asRecord(args.requestJson.reasoning)?.effort !== expectedEffort) {
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
  execution?: CloudExecutionSelection;
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
    requestKind,
    requestJson: args.requestJson,
  });
  if (reasoningError) return { ok: false, error: reasoningError };
  return { ok: true, nativeModel, requestKind };
};

export const validateManagedCloudBinding = (args: {
  execution?: CloudExecutionSelection;
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
