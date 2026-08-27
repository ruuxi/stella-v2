import { BACKEND_TOOL_IDS } from "../lib/agent_constants";
import { validateAgainstSchema } from "../lib/validator";
import {
  assistantText,
  buildContextFromChatMessages,
  completeManagedChat,
  estimateManagedContextInputTokens,
  type ManagedDispatchGuard,
  type ManagedModelBillingContext,
} from "../runtime_ai/managed";
import {
  usageSummaryFromAssistant,
  type ManagedUsageSummary,
} from "../lib/managed_usage";
import type { AssistantMessage, Context } from "../runtime_ai/types";
import type { ResolvedModelConfig } from "./model_resolver";
import { withModelFailoverAsync } from "./model_failover";
import type { BackendToolDefinition, BackendToolSet } from "../tools/types";
import {
  createManagedDispatchRequestFingerprint,
  estimateManagedModelFallbackCostMicroCents,
} from "../lib/managed_dispatch";

type ToolCallLike = {
  toolName?: string;
};

type StepLike = {
  toolCalls?: ToolCallLike[];
};

export type SharedExecutionArgs = {
  system?: string;
  messages?: unknown;
  tools?: BackendToolSet;
  maxSteps?: number;
  /** Acquired and settled around every primary/fallback/tool-loop dispatch. */
  modelDispatchGuard: ManagedDispatchGuard;
  /** Exact immutable attribution and conservative per-model crash estimate. */
  modelBilling: ManagedModelBillingContext;
  onStepFinish?: (args: { toolCalls?: ToolCallLike[] }) => void;
  onFinish?: (args: {
    usage: ManagedUsageSummary | undefined;
    totalUsage: ManagedUsageSummary | undefined;
  }) => void;
};

export type ManagedModelBillingIdentity = Pick<
  ManagedModelBillingContext,
  "requestFingerprint" | "agentType" | "conversationId"
>;

const managedModelBillingIdentity = (
  billing: ManagedModelBillingContext,
): ManagedModelBillingIdentity => ({
  requestFingerprint: billing.requestFingerprint,
  agentType: billing.agentType,
  ...(billing.conversationId ? { conversationId: billing.conversationId } : {}),
});

const deriveManagedModelBillingForRuntimeContext = (args: {
  identity: ManagedModelBillingIdentity;
  context: Context;
  configs: readonly ResolvedModelConfig[];
}): ManagedModelBillingContext => {
  if (args.configs.length === 0) {
    throw new Error(
      "Managed model billing requires at least one model config.",
    );
  }
  const inputTokens = estimateManagedContextInputTokens(args.context);
  const fallbackCostMicroCentsByModel = Object.fromEntries(
    args.configs.map((config) => {
      if (
        !Number.isFinite(config.maxOutputTokens) ||
        (config.maxOutputTokens ?? 0) <= 0
      ) {
        throw new Error(
          `Managed model ${config.model} has no positive output bound.`,
        );
      }
      return [
        config.model,
        estimateManagedModelFallbackCostMicroCents({
          model: config.model,
          inputTokens,
          maxOutputTokens: config.maxOutputTokens!,
        }),
      ];
    }),
  );
  return {
    ...args.identity,
    fallbackCostMicroCents: Math.max(
      ...Object.values(fallbackCostMicroCentsByModel),
    ),
    fallbackCostMicroCentsByModel,
  };
};

/**
 * Derive the immutable paid-model context only after the real system prompt,
 * tool schemas, messages, and primary/fallback configs exist. Callers own the
 * stable request identity; this helper owns the conservative cost bounds.
 */
export function deriveManagedModelBillingContext(args: {
  identity: ManagedModelBillingIdentity;
  system?: string;
  messages?: unknown;
  tools?: BackendToolSet;
  configs: readonly ResolvedModelConfig[];
}): ManagedModelBillingContext {
  const context = buildContextFromChatMessages(args.messages);
  if (args.system) context.systemPrompt = args.system;
  const toolSchemas = Object.values(args.tools ?? {}).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  }));
  if (toolSchemas.length > 0) context.tools = toolSchemas;
  return deriveManagedModelBillingForRuntimeContext({
    identity: args.identity,
    context,
    configs: args.configs,
  });
}

/**
 * Re-price each logical model step from the live runtime context. Tool calls
 * can append large assistant/tool-result payloads after initial admission, so
 * reusing the turn's initial fallback estimate would understate a later
 * response-loss charge. Physical retries/fallbacks within one step share this
 * deterministic fingerprint; their durable attempt IDs remain distinct.
 */
export async function deriveManagedModelStepBillingContext(args: {
  baseBilling: ManagedModelBillingContext;
  context: Context;
  configs: readonly ResolvedModelConfig[];
  stepIndex: number;
}): Promise<ManagedModelBillingContext> {
  if (!Number.isSafeInteger(args.stepIndex) || args.stepIndex < 0) {
    throw new Error("Managed model billing step index must be non-negative.");
  }
  return deriveManagedModelBillingForRuntimeContext({
    identity: {
      ...managedModelBillingIdentity(args.baseBilling),
      requestFingerprint: await createManagedDispatchRequestFingerprint(
        "managed-model-step",
        `${args.baseBilling.requestFingerprint}\0${args.stepIndex}`,
      ),
    },
    context: args.context,
    configs: args.configs,
  });
}

const NO_RESPONSE_TOOL_NAME = BACKEND_TOOL_IDS.NO_RESPONSE;

export type UsageSummary = ManagedUsageSummary;
export type MaybeUsageSummary = UsageSummary | undefined;
export type UsageSummaryByModel = Record<string, UsageSummary>;

export type StreamExecutionLifecycleState = {
  noResponseCalled: boolean;
  usageSummary?: MaybeUsageSummary;
};

function assertModelExecutionActive(dispatchGuard: ManagedDispatchGuard): void {
  if (!dispatchGuard.signal.aborted) return;
  if (dispatchGuard.signal.reason instanceof Error) {
    throw dispatchGuard.signal.reason;
  }
  const error = new Error("Managed model execution was aborted");
  error.name = "AbortError";
  throw error;
}

/** Execute one nested tool under the enclosing durable model-run authority. */
export async function executeBackendToolWithManagedGuard(args: {
  tool: BackendToolDefinition;
  toolArgs: Record<string, unknown>;
  dispatchGuard: ManagedDispatchGuard;
}): Promise<string> {
  assertModelExecutionActive(args.dispatchGuard);
  const result = await args.tool.execute(args.toolArgs, {
    signal: args.dispatchGuard.signal,
  });
  assertModelExecutionActive(args.dispatchGuard);
  return result;
}

export function hasNoResponseToolCall(toolCalls?: ToolCallLike[]): boolean {
  return Boolean(
    toolCalls?.some((toolCall) => toolCall.toolName === NO_RESPONSE_TOOL_NAME),
  );
}

export function hasNoResponseInSteps(steps?: StepLike[]): boolean {
  return Boolean(steps?.some((step) => hasNoResponseToolCall(step.toolCalls)));
}

export class ToolLoopExhaustedError extends Error {
  readonly maxSteps: number;
  readonly partialText: string;

  constructor(maxSteps: number, partialText = "") {
    super(
      `Tool loop exhausted maxSteps=${maxSteps} before producing a final assistant response.`,
    );
    this.name = "ToolLoopExhaustedError";
    this.maxSteps = maxSteps;
    this.partialText = partialText;
  }
}

export function appendAssistantStepText(
  currentText: string,
  message: AssistantMessage,
): string {
  const nextText = assistantText(message);
  if (!nextText) {
    return currentText;
  }
  if (!currentText) {
    return nextText;
  }
  return `${currentText}\n\n${nextText}`;
}

export function usageSummaryFromFinish(
  totalUsage: MaybeUsageSummary,
): MaybeUsageSummary {
  return totalUsage;
}

export function mergeUsageSummaries(
  ...summaries: Array<MaybeUsageSummary>
): MaybeUsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let reasoningTokens = 0;
  let hasValue = false;

  for (const summary of summaries) {
    if (!summary) {
      continue;
    }
    if (summary.inputTokens !== undefined) {
      inputTokens += summary.inputTokens;
      hasValue = true;
    }
    if (summary.outputTokens !== undefined) {
      outputTokens += summary.outputTokens;
      hasValue = true;
    }
    if (summary.totalTokens !== undefined) {
      totalTokens += summary.totalTokens;
      hasValue = true;
    }
    if (summary.cachedInputTokens !== undefined) {
      cachedInputTokens += summary.cachedInputTokens;
      hasValue = true;
    }
    if (summary.cacheWriteInputTokens !== undefined) {
      cacheWriteInputTokens += summary.cacheWriteInputTokens;
      hasValue = true;
    }
    if (summary.reasoningTokens !== undefined) {
      reasoningTokens += summary.reasoningTokens;
      hasValue = true;
    }
  }

  if (!hasValue) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens:
      totalTokens > 0 || (inputTokens === 0 && outputTokens === 0)
        ? totalTokens
        : inputTokens + outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
  };
}

export function mergeUsageSummaryByModel(
  current: UsageSummaryByModel,
  model: string,
  usage: MaybeUsageSummary,
): UsageSummaryByModel {
  if (!usage) {
    return current;
  }

  return {
    ...current,
    [model]: mergeUsageSummaries(current[model], usage)!,
  };
}

export function splitDurationAcrossModels(
  usageByModel: UsageSummaryByModel,
  durationMs: number,
): Array<{ model: string; usage: UsageSummary; durationMs: number }> {
  const entries = Object.entries(usageByModel).filter(([, usage]) => usage);
  if (entries.length === 0) {
    return [];
  }

  const totalTokens = entries.reduce(
    (sum, [, usage]) => sum + Math.max(0, usage.totalTokens ?? 0),
    0,
  );

  let allocated = 0;
  return entries.map(([model, usage], index) => {
    const isLast = index === entries.length - 1;
    const sliceDuration = isLast
      ? Math.max(0, durationMs - allocated)
      : totalTokens > 0
        ? Math.max(
            0,
            Math.floor(durationMs * ((usage.totalTokens ?? 0) / totalTokens)),
          )
        : Math.floor(durationMs / entries.length);
    allocated += sliceDuration;
    return { model, usage, durationMs: sliceDuration };
  });
}

export function createStreamExecutionLifecycle() {
  let state: StreamExecutionLifecycleState = {
    noResponseCalled: false,
    usageSummary: undefined,
  };

  return {
    onStepFinish: ({ toolCalls }: { toolCalls?: ToolCallLike[] }) => {
      if (hasNoResponseToolCall(toolCalls)) {
        state = {
          ...state,
          noResponseCalled: true,
        };
      }
    },
    onFinish: ({
      totalUsage,
    }: {
      usage: MaybeUsageSummary;
      totalUsage: MaybeUsageSummary;
    }) => {
      state = {
        ...state,
        usageSummary: usageSummaryFromFinish(totalUsage),
      };
    },
    getState: (): StreamExecutionLifecycleState => state,
  };
}

async function runToolLoop(args: {
  resolvedConfig: ResolvedModelConfig;
  fallbackConfig?: ResolvedModelConfig | null;
  sharedArgs: SharedExecutionArgs;
}) {
  const context = buildContextFromChatMessages(args.sharedArgs.messages);
  if (args.sharedArgs.system) {
    context.systemPrompt = args.sharedArgs.system;
  }

  const tools = args.sharedArgs.tools ?? {};
  const toolSchemas = Object.values(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  }));

  let totalUsage: MaybeUsageSummary = undefined;
  let usageByModel: UsageSummaryByModel = {};
  let accumulatedAssistantText = "";
  const maxSteps = Math.max(1, Math.floor(args.sharedArgs.maxSteps ?? 20));

  for (let step = 0; step < maxSteps; step += 1) {
    assertModelExecutionActive(args.sharedArgs.modelDispatchGuard);
    const attemptContext: Context = {
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
    };
    const assistantMessage = await completeManagedChat({
      config: args.resolvedConfig,
      fallbackConfig: args.fallbackConfig,
      dispatchGuard: args.sharedArgs.modelDispatchGuard,
      billing: await deriveManagedModelStepBillingContext({
        baseBilling: args.sharedArgs.modelBilling,
        context: attemptContext,
        configs: [
          args.resolvedConfig,
          ...(args.fallbackConfig ? [args.fallbackConfig] : []),
        ],
        stepIndex: step,
      }),
      context: attemptContext,
    });

    const usage = usageSummaryFromAssistant(assistantMessage);
    totalUsage = mergeUsageSummaries(totalUsage, usage);
    usageByModel = mergeUsageSummaryByModel(
      usageByModel,
      assistantMessage.model,
      usage,
    );

    const toolCalls = assistantMessage.content
      .filter(
        (
          part,
        ): part is {
          type: "toolCall";
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        } => part.type === "toolCall",
      )
      .map((toolCall) => ({
        ...toolCall,
        toolName: toolCall.name,
      }));

    args.sharedArgs.onStepFinish?.({
      toolCalls: toolCalls.map((toolCall) => ({ toolName: toolCall.toolName })),
    });

    context.messages.push(assistantMessage);

    if (toolCalls.length === 0) {
      const finalText = appendAssistantStepText(
        accumulatedAssistantText,
        assistantMessage,
      );
      args.sharedArgs.onFinish?.({
        usage,
        totalUsage,
      });
      return {
        text: finalText,
        totalUsage,
        usageByModel,
        executedModel: assistantMessage.model,
      };
    }

    if (hasNoResponseToolCall(toolCalls)) {
      args.sharedArgs.onFinish?.({
        usage,
        totalUsage,
      });
      return {
        text: "",
        totalUsage,
        usageByModel,
        executedModel: assistantMessage.model,
      };
    }

    accumulatedAssistantText = appendAssistantStepText(
      accumulatedAssistantText,
      assistantMessage,
    );

    for (const toolCall of toolCalls) {
      assertModelExecutionActive(args.sharedArgs.modelDispatchGuard);
      const tool = tools[toolCall.name];
      let resultText = "";
      let isError = false;

      if (!tool) {
        resultText = `Tool ${toolCall.name} is not available.`;
        isError = true;
      } else {
        const validation = validateAgainstSchema(
          tool.parameters,
          toolCall.arguments,
        );
        if (validation.ok === false) {
          resultText = `Invalid tool arguments for ${toolCall.name}: ${validation.reason}`;
          isError = true;
        } else {
          try {
            resultText = await executeBackendToolWithManagedGuard({
              tool,
              toolArgs: toolCall.arguments,
              dispatchGuard: args.sharedArgs.modelDispatchGuard,
            });
          } catch (error) {
            assertModelExecutionActive(args.sharedArgs.modelDispatchGuard);
            resultText = `Tool ${toolCall.name} failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
            isError = true;
          }
        }
      }

      context.messages.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: resultText }],
        isError,
        timestamp: Date.now(),
      });
    }
  }

  args.sharedArgs.onFinish?.({
    usage: totalUsage,
    totalUsage,
  });

  throw new ToolLoopExhaustedError(maxSteps, accumulatedAssistantText);
}

async function withManagedExecutionSettlement<T>(args: {
  dispatchGuard: ManagedDispatchGuard;
  run: () => Promise<T>;
}): Promise<T> {
  let outcome: "succeeded" | "failed" | "aborted" = "failed";
  try {
    const result = await args.run();
    outcome = "succeeded";
    return result;
  } catch (error) {
    outcome = args.dispatchGuard.signal.aborted ? "aborted" : "failed";
    throw error;
  } finally {
    await args.dispatchGuard.finishExecution?.(outcome);
  }
}

export async function streamTextWithFailover(args: {
  resolvedConfig: ResolvedModelConfig;
  fallbackConfig?: ResolvedModelConfig | null;
  sharedArgs: SharedExecutionArgs;
}) {
  const execute = async (config: ResolvedModelConfig) => {
    const sharedArgs = args.sharedArgs;
    const result = await runToolLoop({
      resolvedConfig: config,
      fallbackConfig: undefined,
      sharedArgs,
    });

    return {
      text: Promise.resolve(result.text),
      totalUsage: Promise.resolve(result.totalUsage),
      usageByModel: Promise.resolve(result.usageByModel),
      executedModel: result.executedModel,
    };
  };

  const fallbackConfig = args.fallbackConfig ?? undefined;
  return await withManagedExecutionSettlement({
    dispatchGuard: args.sharedArgs.modelDispatchGuard,
    run: async () =>
      await withModelFailoverAsync(
        () => execute(args.resolvedConfig),
        fallbackConfig ? () => execute(fallbackConfig) : undefined,
      ),
  });
}

export async function generateTextWithFailover(args: {
  resolvedConfig: ResolvedModelConfig;
  fallbackConfig?: ResolvedModelConfig | null;
  sharedArgs: SharedExecutionArgs;
}) {
  const execute = async (config: ResolvedModelConfig) => {
    const sharedArgs = args.sharedArgs;
    const context = buildContextFromChatMessages(sharedArgs.messages);
    if (sharedArgs.system) {
      context.systemPrompt = sharedArgs.system;
    }
    const message = await completeManagedChat({
      config,
      dispatchGuard: sharedArgs.modelDispatchGuard,
      billing: await deriveManagedModelStepBillingContext({
        baseBilling: sharedArgs.modelBilling,
        context,
        configs: [config],
        stepIndex: 0,
      }),
      context,
    });

    return {
      text: assistantText(message),
      usage: usageSummaryFromAssistant(message),
      executedModel: message.model,
    };
  };

  const fallbackConfig = args.fallbackConfig ?? undefined;
  return await withManagedExecutionSettlement({
    dispatchGuard: args.sharedArgs.modelDispatchGuard,
    run: async () =>
      await withModelFailoverAsync(
        () => execute(args.resolvedConfig),
        fallbackConfig ? () => execute(fallbackConfig) : undefined,
      ),
  });
}
