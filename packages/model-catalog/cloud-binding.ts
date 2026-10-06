import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { chatGptRequestViolation } from "@stella/contracts/chatgpt-siwc";

/**
 * The execution fields the binding validators read. Structurally satisfied
 * by a contracts `CloudExecutionSelection` and by the model gateway's
 * turn-token execution, whose `engine` and `provider` are typed independently.
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


export type ConnectedCloudRequestKind = "chatgpt_responses";

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

const nativeRequestedModel = (requestedModel: string): string | null => {
  const wrappedPrefix = "stella/chatgpt/";
  const nativeModel = requestedModel.startsWith(wrappedPrefix)
    ? requestedModel.slice(wrappedPrefix.length)
    : requestedModel;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(nativeModel)
    ? nativeModel
    : null;
};

const expectedNativeEfforts = (
  execution: CloudExecutionBinding,
): ReadonlySet<string> => {
  if (execution.reasoningEffort === "default") return new Set();
  if (execution.reasoningEffort === "none") return new Set(["none", "off"]);
  return new Set([execution.reasoningEffort]);
};

const validateNativeReasoning = (args: {
  execution: CloudExecutionBinding;
  requestJson: Record<string, unknown>;
}): CloudBindingError | null => {
  // Connected subscription defaults belong to the provider. Stella is
  // neither paying for nor pinning that account's provider-side tier.
  if (args.execution.reasoningEffort === "default") return null;
  const effort = asRecord(args.requestJson.reasoning)?.effort;
  if (
    typeof effort !== "string" ||
    !expectedNativeEfforts(args.execution).has(effort.trim().toLowerCase())
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
 * Bind a ChatGPT relay request to the immutable route stored with its turn
 * token. This is deliberately pure so the authorization invariant can be
 * tested without constructing a gateway request context.
 */
export const validateConnectedCloudBinding = (args: {
  execution?: CloudExecutionBinding;
  credentialProvider: "chatgpt";
  requestedModel: string;
  requestPathname: string;
  requestJson: Record<string, unknown>;
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
  // ChatGPT plan usage serves `POST /v1/responses` only (no compaction route).
  if (!args.requestPathname.endsWith("/responses")) {
    return {
      ok: false,
      error: {
        status: 400,
        message: "ChatGPT cloud turns may call only the Responses API",
      },
    };
  }
  const nativeModel = nativeRequestedModel(args.requestedModel);
  if (!nativeModel) {
    return {
      ok: false,
      error: {
        status: 400,
        message: "Engine-credential turns must send an engine-native model id",
      },
    };
  }
  if (args.execution.model !== nativeModel) {
    return {
      ok: false,
      error: {
        status: 403,
        message: "This turn token is not authorized for the requested model",
      },
    };
  }
  // Sign in with ChatGPT's preview limits: store false, stream true, the
  // whole history in `input`, no unsupported fields or hosted tools.
  const violation = chatGptRequestViolation(args.requestJson);
  if (violation) {
    return { ok: false, error: { status: 400, message: violation } };
  }
  const reasoningError = validateNativeReasoning({
    execution: args.execution,
    requestJson: args.requestJson,
  });
  if (reasoningError) return { ok: false, error: reasoningError };
  return { ok: true, nativeModel, requestKind: "chatgpt_responses" };
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
