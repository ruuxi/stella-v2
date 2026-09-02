import OpenAI from "openai";
import {
  resolveManagedGatewayApiKey,
  resolveManagedGatewayConfig,
  type ManagedGatewayProvider,
} from "../lib/managed_gateway";
import {
  buildOpenAICompletionsParams,
  mapStopReason,
} from "./openai_completions";
import {
  DEFAULT_PROVIDER_RETRY_ATTEMPTS,
  isRetryableProviderError,
  retryDelayMs,
  retryProviderRequest,
  sleepForProviderRetry,
} from "./retry";
import { completeSimple, streamSimple } from "./stream";
import { parseOpenAIChatUsage } from "./usage";
import {
  MANAGED_USAGE_BILLING_KIND,
  type ManagedDispatchBillingEnvelope,
  type ManagedDispatchCapturedUsage,
} from "../lib/managed_dispatch";
import { usageSummaryFromAssistant } from "../lib/managed_usage";
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  OpenAICompletionsCompat,
  SimpleStreamOptions,
  TextContent,
  ThinkingLevel,
  Tool,
  ToolCall,
} from "./types";
export { type ManagedUsageSummary } from "../lib/managed_usage";
export { usageSummaryFromAssistant };

export type ManagedProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type ManagedModelConfig = {
  model: string;
  managedGatewayProvider?: ManagedGatewayProvider;
  /**
   * Explicit wire-protocol override. When omitted, the protocol is inferred
   * from the gateway provider; set it for gateways that serve different
   * models over different APIs (OpenRouter: Muse Spark 1.3 Contributor on
   * the Responses API, everything else Chat Completions).
   */
  api?: ManagedProtocol;
  temperature?: number;
  maxOutputTokens?: number;
  serviceTier?: string;
  providerOptions?: Record<string, Record<string, unknown>>;
  /**
   * Input modalities the upstream model actually supports. Resolved at the
   * request entry point from `billing_model_prices` (synced from
   * models.dev). When omitted, `buildManagedModel` defaults to ["text"]
   * so unknown models drop image/audio/video/pdf at the gateway boundary
   * (`transformMessages` swaps unsupported parts for text placeholders)
   * instead of forwarding multi-megabyte data URLs that some providers
   * tokenize as raw character streams.
   */
  modalitiesInput?: ("text" | "image" | "audio" | "video" | "pdf")[];
};

type ManagedUsageBillingEnvelope = Extract<
  ManagedDispatchBillingEnvelope,
  { kind: typeof MANAGED_USAGE_BILLING_KIND }
>;

/** Stable logical attribution reused across physical primary/retry/fallbacks. */
export type ManagedModelBillingContext = Omit<
  ManagedUsageBillingEnvelope,
  "kind" | "model"
> & {
  /** Optional exact conservative estimate for each primary/fallback model. */
  fallbackCostMicroCentsByModel?: Readonly<Record<string, number>>;
};

const managedModelAttemptBilling = (
  billing: ManagedModelBillingContext | undefined,
  model: string,
): ManagedUsageBillingEnvelope | undefined =>
  billing
    ? (() => {
        const {
          fallbackCostMicroCentsByModel,
          fallbackCostMicroCents,
          ...attribution
        } = billing;
        return {
          kind: MANAGED_USAGE_BILLING_KIND,
          ...attribution,
          model,
          fallbackCostMicroCents:
            fallbackCostMicroCentsByModel?.[model] ?? fallbackCostMicroCents,
        };
      })()
    : undefined;

const capturedUsageFromAssistant = (
  message: AssistantMessage,
  startedAt: number,
  success: boolean,
): ManagedDispatchCapturedUsage => ({
  durationMs: Math.max(0, Date.now() - startedAt),
  success,
  ...usageSummaryFromAssistant(message),
});

const assistantHasAuthoritativeProviderUsage = (
  message: AssistantMessage,
): boolean =>
  message.usage.input > 0 ||
  message.usage.output > 0 ||
  message.usage.cacheRead > 0 ||
  message.usage.cacheWrite > 0 ||
  (message.usage.reasoningTokens ?? 0) > 0 ||
  message.usage.totalTokens > 0 ||
  message.usage.cost.total > 0;

const capturedSuccessfulAssistantUsage = (
  message: AssistantMessage,
  startedAt: number,
  billing: ManagedUsageBillingEnvelope,
): ManagedDispatchCapturedUsage => {
  const usage = capturedUsageFromAssistant(message, startedAt, true);
  return assistantHasAuthoritativeProviderUsage(message)
    ? usage
    : { ...usage, costMicroCents: billing.fallbackCostMicroCents };
};

const managedAssistantFailureError = (message: AssistantMessage): Error => {
  const error = new Error(message.errorMessage || "Managed completion failed");
  if (
    message.providerOutcomeUnknown === true ||
    isRetryableProviderError(message)
  ) {
    (
      error as Error & {
        providerOutcomeUnknown?: boolean;
      }
    ).providerOutcomeUnknown = true;
  }
  return error;
};

/** Conservative prompt estimate after system text, history, and tools exist. */
export function estimateManagedContextInputTokens(context: Context): number {
  const serialized = JSON.stringify({
    systemPrompt: context.systemPrompt ?? "",
    messages: context.messages,
    tools: context.tools ?? [],
  });
  // Three UTF-16 code units per token is deliberately more conservative than
  // the four-character relay admission heuristic and includes tool schemas.
  return Math.max(1, Math.ceil(serialized.length / 3));
}

type ManagedCompletionRequest = {
  temperature?: number;
  maxTokens?: number;
  serviceTier?: string;
  reasoning?: ThinkingLevel;
  toolChoice?: ManagedToolChoice;
  responseFormat?: unknown;
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  sessionId?: string;
  cacheRetention?: "none" | "short" | "long";
};

export type ManagedDispatchOutcome =
  | "succeeded"
  | "failed"
  | "aborted"
  | "timed_out"
  | "outcome_unknown";

export type ManagedDispatchLease = {
  /** Aborts this physical provider attempt if its durable lease closes. */
  signal: AbortSignal;
  /** Absolute wall-clock deadline for this physical provider attempt. */
  deadlineAt: number;
  /**
   * Durable last-pre-I/O marker for metered attempts. Before it resolves, an
   * abort is definitively pre-dispatch; after it resolves, a crash may charge.
   */
  markMayHaveDispatched?: () => Promise<void>;
  /** Persist exact variable usage under this receipt before settlement. */
  captureUsage?: (usage: ManagedDispatchCapturedUsage) => Promise<void>;
  /** Successful callback completion is invalid until exact usage is captured. */
  requiresUsageCapture?: boolean;
  /** Acknowledges only this provider try, never the enclosing agent turn. */
  settle: (outcome: ManagedDispatchOutcome) => Promise<void>;
};

export type ManagedDispatchGuard = {
  /** Stable enclosing-run cancellation, including lease loss or migration. */
  signal: AbortSignal;
  /**
   * Acquires or renews dispatch authority immediately before one physical
   * primary, retry, or fallback provider request.
   */
  beginDispatch: (
    billing?: ManagedDispatchBillingEnvelope,
  ) => Promise<ManagedDispatchLease>;
  /** Releases an optional enclosing model/tool execution lease. */
  finishExecution?: (outcome: ManagedDispatchOutcome) => Promise<void>;
};

class ManagedDispatchSettlementError extends Error {
  constructor(cause: unknown) {
    super(
      `Managed provider dispatch settlement failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "ManagedDispatchSettlementError";
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export function composeManagedDispatchGuards(
  ...guards: ManagedDispatchGuard[]
): ManagedDispatchGuard {
  if (guards.length === 0) {
    throw new Error("At least one managed dispatch guard is required.");
  }
  const signal =
    guards.length === 1
      ? guards[0]!.signal
      : AbortSignal.any(guards.map((guard) => guard.signal));
  return {
    signal,
    beginDispatch: async (billing) => {
      const acquired: ManagedDispatchLease[] = [];
      try {
        for (const guard of guards) {
          acquired.push(await guard.beginDispatch(billing));
        }
      } catch (error) {
        const cleanup = await Promise.allSettled(
          acquired.reverse().map((lease) => lease.settle("aborted")),
        );
        const cleanupFailures = cleanup.filter(
          (result) => result.status === "rejected",
        );
        if (cleanupFailures.length > 0) {
          throw new ManagedDispatchSettlementError(
            `Guard acquisition failed and ${cleanupFailures.length} acquired lease(s) could not settle: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        throw error;
      }

      const usageCaptureLeases = acquired.filter((lease) => lease.captureUsage);
      if (usageCaptureLeases.length > 1) {
        const cleanup = await Promise.allSettled(
          acquired.reverse().map((lease) => lease.settle("aborted")),
        );
        if (cleanup.some((result) => result.status === "rejected")) {
          throw new ManagedDispatchSettlementError(
            "Duplicate billing capture authorities could not be settled.",
          );
        }
        throw new Error(
          "Composite managed dispatch acquired multiple billing capture authorities.",
        );
      }

      let settled = false;
      return {
        signal:
          acquired.length === 1
            ? acquired[0]!.signal
            : AbortSignal.any(acquired.map((lease) => lease.signal)),
        deadlineAt: Math.min(...acquired.map((lease) => lease.deadlineAt)),
        markMayHaveDispatched: acquired.some(
          (lease) => lease.markMayHaveDispatched,
        )
          ? async () => {
              for (const lease of acquired) {
                await lease.markMayHaveDispatched?.();
              }
            }
          : undefined,
        captureUsage: usageCaptureLeases[0]?.captureUsage
          ? async (usage: ManagedDispatchCapturedUsage) =>
              await usageCaptureLeases[0]!.captureUsage!(usage)
          : undefined,
        requiresUsageCapture: acquired.some(
          (lease) => lease.requiresUsageCapture,
        ),
        settle: async (outcome) => {
          if (settled) {
            throw new Error("Composite managed dispatch lease settled twice.");
          }
          settled = true;
          const results = await Promise.allSettled(
            acquired.reverse().map((lease) => lease.settle(outcome)),
          );
          const failures = results.filter(
            (result) => result.status === "rejected",
          );
          if (failures.length > 0) {
            throw new ManagedDispatchSettlementError(
              `${failures.length} composite managed dispatch lease settlement(s) failed.`,
            );
          }
        },
      };
    },
    finishExecution: async (outcome) => {
      const results = await Promise.allSettled(
        [...guards]
          .reverse()
          .flatMap((guard) =>
            guard.finishExecution ? [guard.finishExecution(outcome)] : [],
          ),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        throw new ManagedDispatchSettlementError(
          `${failures.length} managed execution settlement(s) failed.`,
        );
      }
    },
  };
}

function managedDispatchAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfManagedDispatchAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw managedDispatchAbortError("Managed provider dispatch was aborted");
}

async function beginManagedDispatchAttempt(args: {
  dispatchGuard: ManagedDispatchGuard;
  callerSignal?: AbortSignal;
  billing?: ManagedDispatchBillingEnvelope;
}) {
  if (args.callerSignal?.aborted) {
    throwIfManagedDispatchAborted(args.callerSignal);
  }

  const lease = await args.dispatchGuard.beginDispatch(args.billing);
  if (!Number.isFinite(lease.deadlineAt)) {
    try {
      await lease.settle("failed");
    } catch (error) {
      throw new ManagedDispatchSettlementError(error);
    }
    throw new Error("Managed provider dispatch returned an invalid deadline");
  }

  const deadlineController = new AbortController();
  let deadlineElapsed = false;
  const remainingMs = lease.deadlineAt - Date.now();
  const abortForDeadline = () => {
    deadlineElapsed = true;
    deadlineController.abort(
      managedDispatchAbortError("Managed provider dispatch timed out"),
    );
  };
  const deadlineTimer =
    remainingMs > 0 ? setTimeout(abortForDeadline, remainingMs) : undefined;
  if (remainingMs <= 0) abortForDeadline();

  const signals = [lease.signal, deadlineController.signal];
  if (args.callerSignal) signals.push(args.callerSignal);
  const signal = AbortSignal.any(signals);
  let settled = false;

  return {
    signal,
    deadlineElapsed: () => deadlineElapsed,
    markMayHaveDispatched: lease.markMayHaveDispatched,
    captureUsage: lease.captureUsage,
    requiresUsageCapture: lease.requiresUsageCapture === true,
    settle: async (outcome: ManagedDispatchOutcome) => {
      if (settled) {
        throw new Error("Managed provider dispatch attempt settled twice");
      }
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      try {
        await lease.settle(outcome);
      } catch (error) {
        throw new ManagedDispatchSettlementError(error);
      }
    },
  };
}

function managedDispatchRunSignal(args: {
  dispatchGuard: ManagedDispatchGuard;
  callerSignal?: AbortSignal;
}): AbortSignal {
  return args.callerSignal
    ? AbortSignal.any([args.dispatchGuard.signal, args.callerSignal])
    : args.dispatchGuard.signal;
}

function managedDispatchFailureOutcome(
  error: unknown,
  attempt: {
    signal: AbortSignal;
    deadlineElapsed: () => boolean;
  },
): ManagedDispatchOutcome {
  if (attempt.deadlineElapsed()) return "timed_out";
  if (
    error &&
    typeof error === "object" &&
    (error as { providerOutcomeUnknown?: unknown }).providerOutcomeUnknown ===
      true
  ) {
    return "outcome_unknown";
  }
  if (
    attempt.signal.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.message.toLowerCase().includes("abort") ||
        error.message.toLowerCase().includes("cancel")))
  ) {
    return "aborted";
  }
  if (isRetryableProviderError(error)) return "outcome_unknown";
  return "failed";
}

/**
 * A physical provider attempt whose lifetime is owned by a response stream.
 * Callers must mark immediately before I/O and keep this handle open until the
 * upstream body and every durable delivery/billing write have joined.
 */
export type ManagedDispatchAttemptHandle = {
  signal: AbortSignal;
  requiresUsageCapture: boolean;
  markMayHaveDispatched: () => Promise<void>;
  captureUsage: (usage: ManagedDispatchCapturedUsage) => Promise<void>;
  settle: (outcome: ManagedDispatchOutcome) => Promise<void>;
  settleFromError: (error: unknown) => Promise<ManagedDispatchOutcome>;
};

export async function openManagedDispatchAttempt(args: {
  dispatchGuard: ManagedDispatchGuard;
  callerSignal?: AbortSignal;
  billing?: ManagedDispatchBillingEnvelope;
}): Promise<ManagedDispatchAttemptHandle> {
  const attempt = await beginManagedDispatchAttempt(args);
  let marked = false;
  let usageCaptured = false;

  return {
    signal: attempt.signal,
    requiresUsageCapture: attempt.requiresUsageCapture,
    markMayHaveDispatched: async () => {
      if (marked) {
        throw new Error("Managed provider dispatch attempt was marked twice.");
      }
      throwIfManagedDispatchAborted(attempt.signal);
      if (
        args.billing?.kind === MANAGED_USAGE_BILLING_KIND &&
        !attempt.captureUsage
      ) {
        throw new Error(
          "Managed usage billing descriptor has no capture authority.",
        );
      }
      await attempt.markMayHaveDispatched?.();
      marked = true;
      throwIfManagedDispatchAborted(attempt.signal);
    },
    captureUsage: async (usage) => {
      if (!marked) {
        throw new Error("Managed provider usage was captured before dispatch.");
      }
      if (!attempt.captureUsage) {
        throw new Error("Managed provider attempt has no usage receipt.");
      }
      await attempt.captureUsage(usage);
      usageCaptured = true;
    },
    settle: async (outcome) => {
      if (
        outcome === "succeeded" &&
        attempt.requiresUsageCapture &&
        !usageCaptured
      ) {
        await attempt.settle("failed");
        throw new Error(
          "Managed provider attempt completed without exact usage capture.",
        );
      }
      await attempt.settle(outcome);
    },
    settleFromError: async (error) => {
      const outcome = managedDispatchFailureOutcome(error, attempt);
      await attempt.settle(outcome);
      return outcome;
    },
  };
}

export async function runManagedDispatchAttempt<T>(args: {
  dispatchGuard: ManagedDispatchGuard;
  callerSignal?: AbortSignal;
  billing?: ManagedDispatchBillingEnvelope;
  run: (
    signal: AbortSignal,
    receipt: {
      captureUsage: (usage: ManagedDispatchCapturedUsage) => Promise<void>;
    },
  ) => Promise<T>;
}): Promise<T> {
  const attempt = await beginManagedDispatchAttempt(args);
  let outcome: ManagedDispatchOutcome = "failed";
  let usageCaptured = false;
  const captureUsage = async (usage: ManagedDispatchCapturedUsage) => {
    if (!attempt.captureUsage) {
      throw new Error("Managed provider attempt has no usage receipt.");
    }
    await attempt.captureUsage(usage);
    usageCaptured = true;
  };
  try {
    throwIfManagedDispatchAborted(attempt.signal);
    if (
      args.billing?.kind === MANAGED_USAGE_BILLING_KIND &&
      !attempt.captureUsage
    ) {
      throw new Error(
        "Managed usage billing descriptor has no capture authority.",
      );
    }
    await attempt.markMayHaveDispatched?.();
    throwIfManagedDispatchAborted(attempt.signal);
    const result = await args.run(attempt.signal, { captureUsage });
    throwIfManagedDispatchAborted(attempt.signal);
    if (attempt.requiresUsageCapture && !usageCaptured) {
      throw new Error(
        "Managed provider attempt completed without exact usage capture.",
      );
    }
    outcome = "succeeded";
    return result;
  } catch (error) {
    outcome = managedDispatchFailureOutcome(error, attempt);
    throw error;
  } finally {
    await attempt.settle(outcome);
  }
}

async function* withManagedDispatchStream<T>(args: {
  dispatchGuard: ManagedDispatchGuard;
  callerSignal?: AbortSignal;
  billing?: ManagedDispatchBillingEnvelope;
  run: (signal: AbortSignal) => AsyncIterable<T>;
  isErrorEvent: (event: T) => boolean;
  errorEventValue: (event: T) => unknown;
  capturedUsageFromEvent?: (
    event: T,
  ) => ManagedDispatchCapturedUsage | undefined;
}): AsyncGenerator<T> {
  const attempt = await beginManagedDispatchAttempt(args);
  let outcome: ManagedDispatchOutcome = "aborted";
  let sawProviderError = false;
  let providerErrorOutcome: ManagedDispatchOutcome = "failed";
  let usageCaptured = false;
  try {
    throwIfManagedDispatchAborted(attempt.signal);
    if (
      args.billing?.kind === MANAGED_USAGE_BILLING_KIND &&
      !attempt.captureUsage
    ) {
      throw new Error(
        "Managed usage billing descriptor has no capture authority.",
      );
    }
    await attempt.markMayHaveDispatched?.();
    throwIfManagedDispatchAborted(attempt.signal);
    for await (const event of args.run(attempt.signal)) {
      throwIfManagedDispatchAborted(attempt.signal);
      const capturedUsage = args.capturedUsageFromEvent?.(event);
      if (capturedUsage) {
        if (!attempt.captureUsage) {
          throw new Error("Managed provider stream has no usage receipt.");
        }
        await attempt.captureUsage(capturedUsage);
        usageCaptured = true;
      }
      if (args.isErrorEvent(event)) {
        sawProviderError = true;
        providerErrorOutcome = managedDispatchFailureOutcome(
          args.errorEventValue(event),
          attempt,
        );
      }
      yield event;
    }
    throwIfManagedDispatchAborted(attempt.signal);
    if (attempt.requiresUsageCapture && !usageCaptured) {
      throw new Error(
        "Managed provider stream completed without exact usage capture.",
      );
    }
    outcome = sawProviderError ? providerErrorOutcome : "succeeded";
  } catch (error) {
    outcome = managedDispatchFailureOutcome(error, attempt);
    throw error;
  } finally {
    if (outcome === "aborted" && sawProviderError) {
      outcome = providerErrorOutcome;
    }
    await attempt.settle(outcome);
  }
}

type OpenAIChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

type ManagedToolChoice =
  | OpenAIChatToolChoice
  | { type: "function"; name: string };

type ChatRequestMessage = {
  role?: unknown;
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  reasoning_text?: unknown;
  reasoning_signature?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
};

type ChatCompletionReasoningField =
  | "reasoning_content"
  | "reasoning"
  | "reasoning_text";

type ChatCompletionReasoningDetail = {
  type?: unknown;
  id?: unknown;
  data?: unknown;
};

function normalizeImageDetail(
  value: unknown,
): ImageContent["detail"] | undefined {
  return value === "auto" || value === "low" || value === "high"
    ? value
    : undefined;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function normalizeReasoning(value: unknown): ThinkingLevel | undefined {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return undefined;
  }
}

function readReasoningText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => readReasoningText(entry))
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      );
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = ["text", "thinking", "summary", "content"];
  const parts = preferredKeys
    .map((key) => readReasoningText(record[key]))
    .filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function providerFromBaseUrl(baseUrl: string): string {
  if (baseUrl.includes("openrouter.ai")) {
    return "openrouter";
  }
  if (baseUrl.includes("pass.wafer.ai")) {
    return "wafer";
  }
  if (baseUrl.includes("api.fireworks.ai")) {
    return "fireworks";
  }
  if (baseUrl.includes("api.deepseek.com")) {
    return "deepseek";
  }
  if (baseUrl.includes("api.x.ai")) {
    return "xai";
  }
  if (baseUrl.includes("ai-gateway.vercel.sh")) {
    return "vercel-ai-gateway";
  }
  if (baseUrl.includes("api.openai.com")) {
    return "openai";
  }
  if (baseUrl.includes("api.anthropic.com")) {
    return "anthropic";
  }
  if (baseUrl.includes("generativelanguage.googleapis.com")) {
    return "google";
  }
  if (baseUrl.includes("api.meta.ai")) {
    return "meta";
  }
  return "managed";
}

function modelIdForGateway(model: string, provider: string): string {
  if (provider === "deepseek" && model.startsWith("deepseek/")) {
    return model.slice("deepseek/".length);
  }
  if (provider === "wafer") {
    const stripped = model.startsWith("wafer/")
      ? model.slice("wafer/".length)
      : model;
    // Wafer's catalog advertises capitalized slugs; send the exact casing.
    return stripped === "deepseek-v4-flash-0731-fast"
      ? "DeepSeek-V4-Flash-0731-Fast"
      : stripped;
  }
  if (provider === "xai" && model.startsWith("x-ai/")) {
    return model.slice("x-ai/".length);
  }
  if (provider === "openai" && model.startsWith("openai/")) {
    return model.slice("openai/".length);
  }
  if (provider === "meta" && model.startsWith("meta/")) {
    return model.slice("meta/".length);
  }
  return model;
}

function resolveManagedProtocol(args: {
  api?: ManagedProtocol;
  config: ManagedModelConfig;
}): ManagedProtocol {
  if (args.api) {
    return args.api;
  }
  // Per-model override from the mode/pin resolution (see
  // `MANAGED_MODEL_API_OVERRIDES`). Wins over provider inference because
  // routers like OpenRouter host a mix of protocols.
  if (args.config.api) {
    return args.config.api;
  }
  const gateway = resolveManagedGatewayConfig({
    model: args.config.model,
    configuredProvider: args.config.managedGatewayProvider,
  });
  if (
    gateway.provider === "fireworks" ||
    gateway.provider === "deepseek" ||
    gateway.provider === "xai" ||
    gateway.provider === "openai"
  ) {
    return "openai-responses";
  }
  if (gateway.provider === "anthropic") {
    return "anthropic-messages";
  }
  if (gateway.provider === "google") {
    return "google-generative-ai";
  }
  return "openai-completions";
}

function inferCompat(
  config: ManagedModelConfig,
  provider: string,
): OpenAICompletionsCompat {
  const gatewayRouting = config.providerOptions?.gateway;
  const compat: OpenAICompletionsCompat = {
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    maxTokensField: "max_completion_tokens",
    supportsStrictMode: true,
  };

  if (provider === "vercel-ai-gateway" && gatewayRouting) {
    compat.vercelGatewayRouting = {
      only: asStringArray(gatewayRouting.only),
      order: asStringArray(gatewayRouting.order),
    };
  }
  if (provider === "openrouter" && gatewayRouting) {
    compat.openRouterRouting = {
      only: asStringArray(gatewayRouting.only),
      order: asStringArray(gatewayRouting.order),
    };
  }
  return compat;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const filtered = value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
  return filtered.length > 0 ? filtered : undefined;
}

function readTextContent(content: unknown): Array<TextContent | ImageContent> {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<TextContent | ImageContent> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (
      (record.type === "text" ||
        record.type === "input_text" ||
        record.type === "output_text") &&
      typeof record.text === "string"
    ) {
      if (record.text.length > 0) {
        blocks.push({ type: "text", text: record.text });
      }
      continue;
    }

    if (record.type === "image_url" || record.type === "input_image") {
      const imageRecord =
        record.image_url && typeof record.image_url === "object"
          ? (record.image_url as Record<string, unknown>)
          : null;
      const imageUrl =
        typeof record.image_url === "string"
          ? record.image_url
          : imageRecord && typeof imageRecord.url === "string"
            ? imageRecord.url
            : typeof record.url === "string"
              ? record.url
              : null;
      if (!imageUrl) {
        continue;
      }

      const detail = normalizeImageDetail(imageRecord?.detail ?? record.detail);
      if (imageUrl.startsWith("data:")) {
        const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
          continue;
        }
        blocks.push({
          type: "image",
          mimeType: match[1],
          data: match[2],
          detail,
        });
        continue;
      }

      blocks.push({
        type: "image",
        url: imageUrl,
        detail,
      });
    }
  }

  return blocks;
}

function readAssistantTextBlocks(content: unknown): TextContent[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: TextContent[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (
      (record.type === "text" || record.type === "output_text") &&
      typeof record.text === "string" &&
      record.text.length > 0
    ) {
      blocks.push({ type: "text", text: record.text });
      continue;
    }
    if (Array.isArray(record.content)) {
      blocks.push(...readAssistantTextBlocks(record.content));
    }
  }
  return blocks;
}

function readAssistantToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const toolCalls: ToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const functionRecord =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : null;
    const id = typeof record.id === "string" ? record.id : "";
    const name =
      functionRecord && typeof functionRecord.name === "string"
        ? functionRecord.name
        : "";
    const rawArguments =
      functionRecord && typeof functionRecord.arguments === "string"
        ? functionRecord.arguments
        : "{}";
    if (!id || !name) {
      continue;
    }

    let parsedArguments: Record<string, unknown> = {};
    try {
      parsedArguments = JSON.parse(rawArguments) as Record<string, unknown>;
    } catch {
      parsedArguments = {};
    }

    toolCalls.push({
      type: "toolCall",
      id,
      name,
      arguments: parsedArguments,
    });
  }
  return toolCalls;
}

function readAssistantReasoningBlocks(
  message: ChatRequestMessage,
): AssistantMessage["content"] {
  const reasoningFields: ChatCompletionReasoningField[] = [
    "reasoning_content",
    "reasoning",
    "reasoning_text",
  ];
  for (const field of reasoningFields) {
    const thinking = readReasoningText(message[field]);
    if (!thinking) {
      continue;
    }
    return [
      {
        type: "thinking",
        thinking,
        thinkingSignature:
          typeof message.reasoning_signature === "string" &&
          message.reasoning_signature.trim().length > 0
            ? message.reasoning_signature.trim()
            : field,
      },
    ];
  }
  return [];
}

function readTools(value: unknown): Tool[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tools: Tool[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const functionRecord =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : null;
    if (!functionRecord) {
      continue;
    }
    const name =
      typeof functionRecord.name === "string" ? functionRecord.name : "";
    if (!name) {
      continue;
    }
    tools.push({
      name,
      description:
        typeof functionRecord.description === "string"
          ? functionRecord.description
          : "",
      parameters:
        functionRecord.parameters &&
        typeof functionRecord.parameters === "object"
          ? (functionRecord.parameters as Record<string, unknown>)
          : { type: "object", properties: {} },
      strict: functionRecord.strict === true,
    });
  }

  return tools.length > 0 ? tools : undefined;
}

/**
 * Derives the `Model.input` modality set from the resolved
 * `ManagedModelConfig.modalitiesInput`. Stella's `Model.input` only
 * tracks "text" and "image" today (audio/video/pdf are not natively
 * supported on the runtime side), so we narrow models.dev's broader
 * modality list to that subset. Defaults to ["text"] when modalities
 * are unknown so unknown models drop image data URLs at the gateway
 * boundary instead of being forwarded to a provider that may tokenize
 * the data URL as raw characters.
 */
function resolveModelInput(
  modalitiesInput: ManagedModelConfig["modalitiesInput"],
): ("text" | "image")[] {
  if (!modalitiesInput || modalitiesInput.length === 0) {
    return ["text"];
  }
  const supportsImage = modalitiesInput.includes("image");
  return supportsImage ? ["text", "image"] : ["text"];
}

export function buildManagedModel<TApi extends Api>(
  config: ManagedModelConfig,
  api: TApi,
  headers?: Record<string, string>,
): Model<TApi> {
  const managedGateway = resolveManagedGatewayConfig({
    model: config.model,
    configuredProvider: config.managedGatewayProvider,
  });
  const provider = providerFromBaseUrl(managedGateway.baseURL);
  const modelId = modelIdForGateway(config.model, provider);
  const defaultHeaders: Record<string, string> = { ...headers };
  if (
    provider === "openrouter" ||
    managedGateway.baseURL.includes("openrouter.ai")
  ) {
    defaultHeaders["HTTP-Referer"] ??= "https://stella.sh";
    defaultHeaders["X-OpenRouter-Title"] ??= "Stella";
  }
  // Per-gateway requirements (Wafer's per-request ZDR opt-in) come from the
  // gateway config so the runtime and the relay share one definition.
  for (const [key, value] of Object.entries(
    managedGateway.extraHeaders ?? {},
  )) {
    defaultHeaders[key] ??= value;
  }
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: managedGateway.baseURL,
    reasoning: true,
    input: resolveModelInput(config.modalitiesInput),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: config.maxOutputTokens ?? 16_384,
    headers: defaultHeaders,
    compat:
      api === "openai-completions"
        ? (inferCompat(config, provider) as Model<TApi>["compat"])
        : undefined,
  };
}

/**
 * Drop image content blocks from every user / toolResult message in the
 * context, replacing them with a short text marker so the model still
 * sees that *something* was attached. Used by the fallback path: when
 * the primary model accepts images but the fallback doesn't, sending
 * the image parts through anyway makes the fallback 404 (e.g.
 * OpenRouter: "No endpoints found that support image input"), which
 * masks the real primary failure.
 */
export function stripImageContentFromContext(context: Context): Context {
  const placeholder: TextContent = {
    type: "text",
    text: "(image omitted: fallback model is text-only)",
  };

  const stripBlocks = <T extends TextContent | ImageContent>(
    blocks: T[],
  ): (TextContent | ImageContent)[] => {
    const filtered = blocks.filter(
      (block): block is Exclude<T, ImageContent> => block.type !== "image",
    );
    if (filtered.length === blocks.length) return blocks;
    return filtered.length > 0 ? filtered : [placeholder];
  };

  const messages = context.messages.map((message) => {
    if (message.role === "user") {
      if (typeof message.content === "string") return message;
      const next = stripBlocks(message.content);
      return next === message.content ? message : { ...message, content: next };
    }
    if (message.role === "toolResult") {
      const next = stripBlocks(message.content);
      return next === message.content ? message : { ...message, content: next };
    }
    return message;
  });

  return { ...context, messages };
}

export function buildContextFromChatMessages(
  messages: unknown,
  tools?: unknown,
): Context {
  const systemParts: string[] = [];
  const runtimeMessages: Context["messages"] = [];

  if (Array.isArray(messages)) {
    for (const message of messages as ChatRequestMessage[]) {
      const role = typeof message.role === "string" ? message.role : "";
      const blocks = readTextContent(message.content);
      if (role === "system" || role === "developer") {
        const text = blocks
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        if (text) {
          runtimeMessages.push({
            role,
            content: text,
            timestamp: Date.now(),
          });
        }
        continue;
      }

      if (role === "user") {
        if (blocks.length > 0) {
          runtimeMessages.push({
            role: "user",
            content: blocks,
            timestamp: Date.now(),
          });
        }
        continue;
      }

      if (role === "assistant") {
        const content = [
          ...readAssistantReasoningBlocks(message),
          ...blocks.filter(
            (block): block is TextContent => block.type === "text",
          ),
          ...readAssistantToolCalls(message.tool_calls),
        ];
        if (content.length > 0) {
          runtimeMessages.push({
            role: "assistant",
            content,
            timestamp: Date.now(),
            stopReason: content.some((block) => block.type === "toolCall")
              ? "toolUse"
              : "stop",
            usage: emptyUsage(),
            api: "openai-completions",
            provider: "managed",
            model: "stella",
          });
        }
        continue;
      }

      if (role === "tool" && typeof message.tool_call_id === "string") {
        runtimeMessages.push({
          role: "toolResult",
          toolCallId: message.tool_call_id,
          toolName: typeof message.name === "string" ? message.name : "",
          content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
          isError: false,
          timestamp: Date.now(),
        });
      }
    }
  }

  return {
    ...(systemParts.length > 0
      ? { systemPrompt: systemParts.join("\n\n") }
      : {}),
    messages: runtimeMessages,
    ...(readTools(tools) ? { tools: readTools(tools) } : {}),
  };
}

function buildSimpleOptions(args: {
  config: ManagedModelConfig;
  request?: ManagedCompletionRequest;
}): SimpleStreamOptions & {
  toolChoice?: ManagedToolChoice;
  responseFormat?: unknown;
  extraBody?: Record<string, unknown>;
} {
  const reasoning =
    args.request?.reasoning ??
    normalizeReasoning(args.config.providerOptions?.openai?.reasoningEffort) ??
    (args.config.providerOptions?.openai?.forceReasoning ? "high" : undefined);

  const managedGateway = resolveManagedGatewayConfig({
    model: args.config.model,
    configuredProvider: args.config.managedGatewayProvider,
  });
  const extraBody: Record<string, unknown> = {
    ...(args.request?.extraBody ?? {}),
  };
  const gatewayRouting = args.config.providerOptions?.gateway;

  if (
    managedGateway.baseURL.includes("openrouter.ai") &&
    gatewayRouting &&
    extraBody.provider === undefined
  ) {
    extraBody.provider = gatewayRouting;
  }

  if (
    managedGateway.baseURL.includes("ai-gateway.vercel.sh") &&
    gatewayRouting &&
    extraBody.providerOptions === undefined
  ) {
    extraBody.providerOptions = { gateway: gatewayRouting };
  }

  if (
    args.request?.toolChoice !== undefined &&
    extraBody.tool_choice === undefined
  ) {
    extraBody.tool_choice = args.request.toolChoice;
  }

  if (
    args.request?.responseFormat !== undefined &&
    extraBody.response_format === undefined
  ) {
    extraBody.response_format = args.request.responseFormat;
  }

  return {
    temperature: args.request?.temperature ?? args.config.temperature,
    maxTokens: args.request?.maxTokens ?? args.config.maxOutputTokens,
    serviceTier: args.request?.serviceTier ?? args.config.serviceTier,
    reasoning,
    toolChoice: args.request?.toolChoice,
    responseFormat: args.request?.responseFormat,
    extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
    signal: args.request?.signal,
    apiKey: resolveManagedGatewayApiKey(managedGateway),
    // Managed retries live in completeManagedChat/streamManagedChat so the
    // transaction-plane lifecycle fence runs immediately before every
    // provider attempt. Anthropic's transport otherwise retries internally
    // without returning through that fence. Its retry helper clamps zero to
    // one total attempt, while the OpenAI SDK interprets zero as no retries.
    maxRetries: 0,
    headers: args.request?.headers,
    sessionId: args.request?.sessionId,
    cacheRetention: args.request?.cacheRetention,
  };
}

async function completeManagedOpenAICompletions(args: {
  config: ManagedModelConfig;
  context: Context;
  request?: ManagedCompletionRequest;
}): Promise<AssistantMessage> {
  const managedGateway = resolveManagedGatewayConfig({
    model: args.config.model,
    configuredProvider: args.config.managedGatewayProvider,
  });
  const apiKey = resolveManagedGatewayApiKey(managedGateway);
  if (!apiKey) {
    throw new Error(`Missing ${managedGateway.apiKeyEnvVar}`);
  }

  const model = buildManagedModel(
    args.config,
    "openai-completions",
    args.request?.headers,
  );
  const client = new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    maxRetries: 0,
    defaultHeaders: model.headers,
  });
  const params = buildOpenAICompletionsParams(
    model,
    args.context,
    {
      ...buildSimpleOptions({
        config: args.config,
        request: args.request,
      }),
      reasoningEffort:
        normalizeReasoning(
          args.config.providerOptions?.openai?.reasoningEffort,
        ) || args.request?.reasoning,
      toolChoice: args.request?.toolChoice,
      responseFormat: args.request?.responseFormat,
    },
    false,
  );

  const response = await client.chat.completions.create(
    params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    args.request?.signal ? { signal: args.request.signal } : undefined,
  );
  const choice = response.choices?.[0];
  const message = choice?.message;
  const stopReason = mapStopReason(choice?.finish_reason ?? "stop");

  const content: AssistantMessage["content"] = [];
  const reasoningMessage = message as Partial<
    Record<ChatCompletionReasoningField, unknown>
  > & {
    reasoning_details?: unknown;
  };
  const reasoningFields: ChatCompletionReasoningField[] = [
    "reasoning_content",
    "reasoning",
    "reasoning_text",
  ];
  for (const field of reasoningFields) {
    const thinking = readReasoningText(reasoningMessage[field]);
    if (!thinking) {
      continue;
    }
    content.push({
      type: "thinking",
      thinking,
      thinkingSignature: field,
    });
    break;
  }
  content.push(...readAssistantTextBlocks(message?.content));
  if (Array.isArray(message?.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!("function" in toolCall)) {
        continue;
      }
      let parsedArguments: Record<string, unknown> = {};
      try {
        parsedArguments = JSON.parse(
          toolCall.function.arguments || "{}",
        ) as Record<string, unknown>;
      } catch {
        parsedArguments = {};
      }
      content.push({
        type: "toolCall",
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parsedArguments,
      });
    }
  }
  if (Array.isArray(reasoningMessage.reasoning_details)) {
    for (const detail of reasoningMessage.reasoning_details as ChatCompletionReasoningDetail[]) {
      if (
        detail?.type !== "reasoning.encrypted" ||
        typeof detail.id !== "string" ||
        typeof detail.data !== "string"
      ) {
        continue;
      }
      const matchingToolCall = content.find(
        (block) => block.type === "toolCall" && block.id === detail.id,
      );
      if (matchingToolCall?.type === "toolCall") {
        matchingToolCall.thoughtSignature = JSON.stringify(detail);
      }
    }
  }

  const usage = parseOpenAIChatUsage(response.usage, model);

  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    ...(stopReason === "error"
      ? {
          errorMessage:
            typeof choice?.finish_reason === "string"
              ? `Completion ended with finish_reason=${choice.finish_reason}`
              : "Completion ended in an error state",
        }
      : {}),
    timestamp: Date.now(),
  };
}

export async function completeManagedChat(args: {
  config: ManagedModelConfig;
  fallbackConfig?: ManagedModelConfig | null;
  context: Context;
  api?: ManagedProtocol;
  request?: ManagedCompletionRequest;
  /** Acquired and settled around every physical provider try. */
  dispatchGuard: ManagedDispatchGuard;
  /** Exact per-physical-attempt billing receipt attribution. */
  billing?: ManagedModelBillingContext;
}): Promise<AssistantMessage> {
  const runSignal = managedDispatchRunSignal({
    dispatchGuard: args.dispatchGuard,
    callerSignal: args.request?.signal,
  });
  const execute = async (config: ManagedModelConfig, context: Context) => {
    const api = resolveManagedProtocol({ api: args.api, config });
    const message = await retryProviderRequest(
      () => {
        const startedAt = Date.now();
        const billing = managedModelAttemptBilling(args.billing, config.model);
        return runManagedDispatchAttempt({
          dispatchGuard: args.dispatchGuard,
          callerSignal: runSignal,
          ...(billing ? { billing } : {}),
          run: async (signal, receipt) => {
            const message = await completeSimple(
              buildManagedModel(config, api, args.request?.headers),
              context,
              buildSimpleOptions({
                config,
                request: { ...args.request, signal },
              }),
            );
            // Protocol adapters represent transport/provider failures as a
            // terminal assistant message. Throw inside the retry closure so a
            // retryable failure returns through a fresh dispatch lease instead
            // of silently bypassing the outer retry loop.
            if (message.stopReason === "aborted") {
              if (billing && assistantHasAuthoritativeProviderUsage(message)) {
                await receipt.captureUsage(
                  capturedUsageFromAssistant(message, startedAt, false),
                );
              }
              throw managedDispatchAbortError(
                message.errorMessage || "Managed completion was aborted",
              );
            }
            if (message.stopReason === "error") {
              if (billing && assistantHasAuthoritativeProviderUsage(message)) {
                await receipt.captureUsage(
                  capturedUsageFromAssistant(message, startedAt, false),
                );
              }
              throw managedAssistantFailureError(message);
            }
            if (billing) {
              await receipt.captureUsage(
                capturedSuccessfulAssistantUsage(message, startedAt, billing),
              );
            }
            return message;
          },
        });
      },
      {
        signal: runSignal,
        onRetry: ({ attempt, delayMs, error }) => {
          console.warn(
            `[managed-model] retrying provider request | model=${config.model} | attempt=${attempt} | delayMs=${delayMs} | error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      },
    );
    return message;
  };

  try {
    return await execute(args.config, args.context);
  } catch (error) {
    if (!args.fallbackConfig) {
      throw error;
    }
    console.warn(
      `[managed-model] primary model failed, attempting fallback | primary=${args.config.model} | fallback=${args.fallbackConfig.model} | error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const fallbackContext = args.fallbackConfig.modalitiesInput?.includes(
      "image",
    )
      ? args.context
      : stripImageContentFromContext(args.context);
    return await execute(args.fallbackConfig, fallbackContext);
  }
}

export function streamManagedChat(args: {
  config: ManagedModelConfig;
  fallbackConfig?: ManagedModelConfig | null;
  context: Context;
  api?: ManagedProtocol;
  request?: ManagedCompletionRequest;
  /** Acquired and settled around every physical provider try. */
  dispatchGuard: ManagedDispatchGuard;
  /** Exact per-physical-attempt billing receipt attribution. */
  billing?: ManagedModelBillingContext;
}) {
  const runSignal = managedDispatchRunSignal({
    dispatchGuard: args.dispatchGuard,
    callerSignal: args.request?.signal,
  });
  const streamForConfig = (
    config: ManagedModelConfig,
    context: Context,
    signal: AbortSignal,
  ) => {
    const api = resolveManagedProtocol({ api: args.api, config });
    return streamSimple(
      buildManagedModel(config, api, args.request?.headers),
      context,
      buildSimpleOptions({
        config,
        request: { ...args.request, signal },
      }),
    );
  };

  const streamDispatchAttempt = (
    config: ManagedModelConfig,
    context: Context,
  ) => {
    const startedAt = Date.now();
    const billing = managedModelAttemptBilling(args.billing, config.model);
    return withManagedDispatchStream({
      dispatchGuard: args.dispatchGuard,
      callerSignal: runSignal,
      ...(billing ? { billing } : {}),
      run: (signal) => streamForConfig(config, context, signal),
      isErrorEvent: (event) => event.type === "error",
      errorEventValue: (event) =>
        event.type === "error" ? event.error : undefined,
      capturedUsageFromEvent: billing
        ? (event) =>
            event.type === "done"
              ? capturedSuccessfulAssistantUsage(
                  event.message,
                  startedAt,
                  billing,
                )
              : event.type === "error"
                ? assistantHasAuthoritativeProviderUsage(event.error)
                  ? capturedUsageFromAssistant(event.error, startedAt, false)
                  : undefined
                : undefined
        : undefined,
    });
  };

  const fallbackConfig = args.fallbackConfig ?? undefined;
  // When the fallback model can't accept images, strip image parts from
  // the context before invoking it. Without this, falling back from an
  // image-capable primary (e.g. Anthropic) to a text-only fallback (e.g.
  // deepseek-v4-flash via OpenRouter) surfaces a misleading "No
  // endpoints found that support image input" 404 from the wrong
  // provider — the user only ever sees the secondary failure, never the
  // real reason the primary failed.
  const fallbackContext =
    fallbackConfig && !fallbackConfig.modalitiesInput?.includes("image")
      ? stripImageContentFromContext(args.context)
      : args.context;

  return (async function* () {
    let emittedOutput = false;
    const maxAttempts = DEFAULT_PROVIDER_RETRY_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        let retryPrimary = false;
        let retryPrimaryDelayMs = 0;
        let primaryFailureEvent: Extract<
          AssistantMessageEvent,
          { type: "error" }
        > | null = null;
        for await (const event of streamDispatchAttempt(
          args.config,
          args.context,
        )) {
          if (event.type === "error" && !emittedOutput) {
            if (
              attempt < maxAttempts &&
              isRetryableProviderError(event.error)
            ) {
              retryPrimaryDelayMs = retryDelayMs(attempt, event.error);
              console.warn(
                `[managed-model] retrying provider stream | model=${args.config.model} | attempt=${attempt} | delayMs=${retryPrimaryDelayMs} | error=${
                  event.error.errorMessage || event.reason
                }`,
              );
              retryPrimary = true;
              break;
            }
            primaryFailureEvent = event;
            break;
          }

          if (event.type !== "error") {
            emittedOutput = true;
          }
          yield event;
        }
        if (retryPrimary) {
          await sleepForProviderRetry(retryPrimaryDelayMs, runSignal);
          continue;
        }
        if (primaryFailureEvent) {
          if (fallbackConfig) {
            console.warn(
              `[managed-model] primary model failed before streaming output, attempting fallback | primary=${args.config.model} | fallback=${fallbackConfig.model} | error=${
                primaryFailureEvent.error.errorMessage ||
                primaryFailureEvent.reason
              }`,
            );
            for await (const fallbackEvent of streamDispatchAttempt(
              fallbackConfig,
              fallbackContext,
            )) {
              yield fallbackEvent;
            }
          } else {
            yield primaryFailureEvent;
          }
          return;
        }
        return;
      } catch (error) {
        if (emittedOutput) {
          throw error;
        }
        if (attempt < maxAttempts && isRetryableProviderError(error)) {
          const delayMs = retryDelayMs(attempt, error);
          console.warn(
            `[managed-model] retrying provider stream | model=${args.config.model} | attempt=${attempt} | delayMs=${delayMs} | error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await sleepForProviderRetry(delayMs, runSignal);
          continue;
        }
        if (!isRetryableProviderError(error)) {
          throw error;
        }
        if (fallbackConfig) {
          console.warn(
            `[managed-model] primary model failed before streaming output, attempting fallback | primary=${args.config.model} | fallback=${fallbackConfig.model} | error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          for await (const fallbackEvent of streamDispatchAttempt(
            fallbackConfig,
            fallbackContext,
          )) {
            yield fallbackEvent;
          }
          return;
        }
        throw error;
      }
    }
  })();
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
