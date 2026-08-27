import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { buildSystemPrompt } from "../agent/prompt_builder";
import { createTools } from "../tools/index";
import { resolveManagedModelConfigs } from "../agent/model_resolver";
import {
  createStreamExecutionLifecycle,
  deriveManagedModelBillingContext,
  streamTextWithFailover,
  type ManagedModelBillingIdentity,
} from "../agent/model_execution";
import { buildBackendJobModeSystemPrompt } from "../prompts/index";
import {
  type ManagedDispatchGuard,
  type ManagedDispatchOutcome,
} from "../runtime_ai/managed";
import { isRetryableProviderError } from "../runtime_ai/retry";
import type { ManagedUsageSummary } from "../lib/managed_usage";

export type RunAgentTurnResult = {
  text: string;
  silent: boolean;
  usage?: ManagedUsageSummary;
  /**
   * Releases the enclosing model/tool execution only after the caller's
   * synchronous usage, persistence, and delivery CAS have all completed.
   * The handle is once-only so catch/finally races cannot double-settle it.
   */
  settleExecution: (outcome: ManagedDispatchOutcome) => Promise<void>;
};

export type RunAgentTurnBillingIdentity = ManagedModelBillingIdentity;

type RunAgentTurnArgs = {
  ctx: ActionCtx;
  conversationId: Id<"conversations">;
  prompt: string;
  agentType: string;
  ownerId: string;
  ownerGeneration: string;
  modelDispatchGuard: ManagedDispatchGuard;
  /** Stable caller-owned identity; exact cost bounds are derived in-run. */
  billingIdentity: RunAgentTurnBillingIdentity;
  /** Exact remote authority ACK after all physical receipts are durable. */
  acknowledgeUsageDisposition?: () => Promise<void>;
  userMessageId?: Id<"events">;
  transient?: boolean;
  modelOverride?: string | null;
};

/**
 * Module-level cache for ensureBuiltins. In Convex's serverless environment,
 * cold starts reset this state — that's fine because the fallback (re-running
 * ensureBuiltins) is idempotent and safe. The cache simply avoids redundant
 * DB writes within the same warm instance.
 */
const BUILTIN_ENSURE_CACHE_TTL_MS = 5 * 60 * 1000;
let builtinEnsurePromise: Promise<void> | null = null;
let builtinEnsureSucceededAt = 0;

const ensureBuiltins = async (ctx: ActionCtx) => {
  const now = Date.now();
  if (now - builtinEnsureSucceededAt < BUILTIN_ENSURE_CACHE_TTL_MS) {
    return;
  }
  if (!builtinEnsurePromise) {
    builtinEnsurePromise = (async () => {
      await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});
      builtinEnsureSucceededAt = Date.now();
    })().finally(() => {
      builtinEnsurePromise = null;
    });
  }
  await builtinEnsurePromise;
};

const errorNameAndMessage = (error: unknown): string => {
  if (error instanceof Error)
    return `${error.name} ${error.message}`.toLowerCase();
  return String(error ?? "").toLowerCase();
};

/** Preserve the most specific terminal outcome that survived to the runner. */
export const managedExecutionOutcomeFromError = (
  error: unknown,
  signal: AbortSignal,
): ManagedDispatchOutcome => {
  const reason = signal.aborted ? signal.reason : undefined;
  const combined = `${errorNameAndMessage(error)} ${errorNameAndMessage(reason)}`;
  if (
    combined.includes("timeout") ||
    combined.includes("timed out") ||
    combined.includes("deadline") ||
    combined.includes("expired")
  ) {
    return "timed_out";
  }
  if (
    (error &&
      typeof error === "object" &&
      (error as { providerOutcomeUnknown?: unknown }).providerOutcomeUnknown ===
        true) ||
    isRetryableProviderError(error)
  ) {
    return "outcome_unknown";
  }
  if (
    signal.aborted ||
    combined.includes("abort") ||
    combined.includes("cancel")
  ) {
    return "aborted";
  }
  return "failed";
};

export const createManagedExecutionSettlementHandle = (
  guard: ManagedDispatchGuard,
): RunAgentTurnResult["settleExecution"] => {
  let settlement: Promise<void> | undefined;
  return async (outcome) => {
    settlement ??= guard.finishExecution?.(outcome) ?? Promise.resolve();
    await settlement;
  };
};

export async function runAgentTurn({
  ctx,
  conversationId,
  prompt,
  agentType,
  ownerId,
  ownerGeneration,
  modelDispatchGuard,
  billingIdentity,
  acknowledgeUsageDisposition,
  userMessageId,
  transient,
  modelOverride,
}: RunAgentTurnArgs): Promise<RunAgentTurnResult> {
  const settleExecution =
    createManagedExecutionSettlementHandle(modelDispatchGuard);
  // Model execution must not release the enclosing lease before the runner's
  // awaited usage write, nor before a connector caller's delivery CAS.
  const modelOnlyDispatchGuard: ManagedDispatchGuard = {
    ...modelDispatchGuard,
    finishExecution: undefined,
  };

  try {
    await ensureBuiltins(ctx);

    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: conversationId,
    });
    if (!conversation) {
      return { text: "", silent: false, settleExecution };
    }

    if (conversation.ownerId !== ownerId) {
      throw new Error("Remote-turn conversation ownership changed.");
    }
    if (
      billingIdentity.conversationId !== undefined &&
      billingIdentity.conversationId !== conversationId
    ) {
      throw new Error("Agent-turn billing conversation binding changed.");
    }
    const resolvedOwnerId = ownerId;
    const [{ access, config: resolvedConfig, fallbackConfig }, promptBuild] =
      await Promise.all([
        resolveManagedModelConfigs(ctx, agentType, resolvedOwnerId, {
          modelOverride,
        }),
        buildSystemPrompt(ctx, agentType, {
          ownerId: resolvedOwnerId,
          conversationId,
        }),
      ]);
    if (access.ownerGeneration !== ownerGeneration) {
      throw new Error("Remote-turn owner generation changed.");
    }
    const requestMessages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt.trim() || " " }],
      },
    ];

    const tools = createTools(ctx, {
      agentType,
      toolsAllowlist: promptBuild.toolsAllowlist,
      maxAgentDepth: promptBuild.maxAgentDepth,
      ownerId: resolvedOwnerId,
      ownerGeneration,
      conversationId,
      userMessageId,
      transient: Boolean(transient),
    });

    const streamLifecycle = createStreamExecutionLifecycle();

    const systemPrompt = buildBackendJobModeSystemPrompt(
      promptBuild.systemPrompt,
    );

    const runnerSharedArgs = {
      system: systemPrompt,
      tools,
      messages: requestMessages,
      onStepFinish: streamLifecycle.onStepFinish,
      onFinish: streamLifecycle.onFinish,
      modelDispatchGuard: modelOnlyDispatchGuard,
      modelBilling: deriveManagedModelBillingContext({
        identity: billingIdentity,
        system: systemPrompt,
        messages: requestMessages,
        tools,
        configs: [resolvedConfig, ...(fallbackConfig ? [fallbackConfig] : [])],
      }),
    };

    const result = await streamTextWithFailover({
      resolvedConfig,
      fallbackConfig: fallbackConfig ?? undefined,
      sharedArgs: runnerSharedArgs,
    });

    const text = await result.text;
    const { noResponseCalled, usageSummary } = streamLifecycle.getState();

    // Every physical primary/retry/fallback receipt is already exact-billed.
    // Keep only the caller's no-charge authority ACK before handing it the
    // execution settlement handle; connector persistence/delivery follows.
    await acknowledgeUsageDisposition?.();

    return {
      text,
      silent: noResponseCalled,
      usage: usageSummary,
      settleExecution,
    };
  } catch (error) {
    const outcome = managedExecutionOutcomeFromError(
      error,
      modelDispatchGuard.signal,
    );
    try {
      await settleExecution(outcome);
    } catch (settlementError) {
      throw new AggregateError(
        [error, settlementError],
        "Agent turn failed and its managed execution could not settle.",
      );
    }
    throw error;
  }
}
