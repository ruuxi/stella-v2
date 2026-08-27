import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { buildSystemPrompt } from "./prompt_builder";
import { createTools } from "../tools/index";
import { requireConversationOwnerAction } from "../auth";
import { jsonSchemaValidator, jsonValueValidator } from "../shared_validators";
import { normalizeOptionalInt } from "../lib/number_utils";
import { stableStringify, extractJsonBlock } from "../lib/json";
import { validateAgainstSchema } from "../lib/validator";
import { scrubProviderTerms, scrubValue } from "../lib/provider_redaction";
import { resolveModelConfig, resolveFallbackConfig } from "./model_resolver";
import {
  deriveManagedModelBillingContext,
  streamTextWithFailover,
} from "./model_execution";
import {
  AGENT_INVOKE_SYSTEM_INSTRUCTIONS,
  buildAgentInvokeUserPrompt,
} from "../prompts/index";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  assertManagedUsageAllowed,
  createManagedUsageDispatchGuard,
} from "../lib/managed_billing";
import { createManagedDispatchRequestFingerprint } from "../lib/managed_dispatch";

const MAX_RAW_TEXT = 60_000;
const MAX_SCHEMA_CHARS = 40_000;
const MAX_INPUT_CHARS = 40_000;

const truncate = (value: string, max = MAX_RAW_TEXT) =>
  value.length <= max ? value : `${value.slice(0, max)}\n\n... (truncated)`;

type AgentInvokeResult =
  | {
      ok: false;
      reason: string;
      rawText: string;
    }
  | {
      ok: true;
      rawText: string;
      outputJson: string;
    };

const agentInvokeResultValidator = v.union(
  v.object({
    ok: v.literal(false),
    reason: v.string(),
    rawText: v.string(),
  }),
  v.object({
    ok: v.literal(true),
    rawText: v.string(),
    outputJson: v.string(),
  }),
);

export const invoke = internalAction({
  args: {
    agentType: v.string(),
    mode: v.optional(v.string()),
    prompt: v.optional(v.string()),
    input: v.optional(jsonValueValidator),
    resultSchema: v.optional(jsonSchemaValidator),
    maxSteps: v.optional(v.number()),
    conversationId: v.id("conversations"),
    userMessageId: v.optional(v.id("events")),
  },
  returns: agentInvokeResultValidator,
  handler: async (ctx, args): Promise<AgentInvokeResult> => {
    await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});

    // Agent invoke is a user-facing managed execution. Requiring a concrete
    // conversation prevents the old ownerless internal shape from consuming
    // managed-provider spend without lifecycle, migration, or billing
    // authority.
    const convo = await requireConversationOwnerAction(
      ctx,
      args.conversationId,
    );
    const ownerId = convo.ownerId;

    const promptBuild = await buildSystemPrompt(ctx, args.agentType, {
      ownerId,
    });

    const schemaText = truncate(
      stableStringify(args.resultSchema ?? { type: "object" }),
      MAX_SCHEMA_CHARS,
    );
    const inputText = truncate(
      stableStringify(args.input ?? {}),
      MAX_INPUT_CHARS,
    );
    const mode = args.mode?.trim();
    const prompt = args.prompt?.trim();

    const userPrompt = buildAgentInvokeUserPrompt({
      mode,
      prompt,
      inputText,
      schemaText,
    });

    const maxSteps = normalizeOptionalInt({
      value: args.maxSteps,
      defaultValue: 20,
      min: 1,
      max: 20,
    });

    let rawText = "";
    try {
      const modelAccess = await assertManagedUsageAllowed(ctx, ownerId);
      const baseToolOptions = {
        agentType: args.agentType,
        toolsAllowlist: promptBuild.toolsAllowlist,
        maxAgentDepth: Math.min(promptBuild.maxAgentDepth, 2),
        conversationId: args.conversationId,
        userMessageId: args.userMessageId,
      };
      const tools = createTools(ctx, {
        ...baseToolOptions,
        ownerId,
        ownerGeneration: modelAccess.ownerGeneration,
      });

      const managedExecutionGuard = createManagedUsageDispatchGuard(ctx, {
        ownerId,
        ownerGeneration: modelAccess.ownerGeneration,
        spanExecution: true,
      });
      // Keep the enclosing authority alive until every physical billing
      // receipt and the final tool-loop result are joined below.
      const modelDispatchGuard = {
        ...managedExecutionGuard,
        finishExecution: undefined,
      };

      const invokeSharedBase = {
        system:
          `${promptBuild.systemPrompt}\n\n${AGENT_INVOKE_SYSTEM_INSTRUCTIONS}`.trim(),
        tools,
        maxSteps,
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: userPrompt }],
          },
        ],
        modelDispatchGuard,
      };

      const [resolvedConfig, fallbackConfig] = await Promise.all([
        resolveModelConfig(ctx, args.agentType, ownerId, {
          access: modelAccess,
        }),
        resolveFallbackConfig(ctx, args.agentType, ownerId, {
          access: modelAccess,
        }),
      ]);
      const requestFingerprint = await createManagedDispatchRequestFingerprint(
        "agent-invoke",
        stableStringify({
          ownerId,
          conversationId: args.conversationId,
          userMessageId: args.userMessageId,
          agentType: args.agentType,
          mode,
          prompt,
          input: inputText,
          resultSchema: schemaText,
        }),
      );
      const invokeSharedArgs = {
        ...invokeSharedBase,
        modelBilling: deriveManagedModelBillingContext({
          identity: {
            requestFingerprint,
            agentType: `invoke:${args.agentType}`,
            conversationId: args.conversationId,
          },
          system: invokeSharedBase.system,
          messages: invokeSharedBase.messages,
          tools,
          configs: [
            resolvedConfig,
            ...(fallbackConfig ? [fallbackConfig] : []),
          ],
        }),
      };
      let executionOutcome: "succeeded" | "failed" | "aborted" = "failed";
      try {
        const result = await streamTextWithFailover({
          resolvedConfig,
          fallbackConfig: fallbackConfig ?? undefined,
          sharedArgs: invokeSharedArgs,
        });

        rawText = scrubProviderTerms(truncate(await result.text));
        executionOutcome = "succeeded";
      } catch (error) {
        executionOutcome = managedExecutionGuard.signal.aborted
          ? "aborted"
          : "failed";
        throw error;
      } finally {
        await managedExecutionGuard.finishExecution?.(executionOutcome);
      }
    } catch (error) {
      return {
        ok: false as const,
        reason: scrubProviderTerms(
          (error as Error)?.message || "agent.invoke failed to run the model.",
        ),
        rawText: "",
      };
    }

    const jsonBlock = extractJsonBlock(rawText);
    if (!jsonBlock) {
      return {
        ok: false as const,
        reason: "agent.invoke did not return valid JSON.",
        rawText,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBlock);
    } catch (error) {
      return {
        ok: false as const,
        reason: `Failed to parse JSON: ${(error as Error).message}`,
        rawText,
      };
    }

    const scrubbed = scrubValue(parsed);
    const validation = validateAgainstSchema(
      args.resultSchema as Record<string, unknown> | undefined,
      scrubbed,
    );
    if (validation.ok === false) {
      return {
        ok: false as const,
        reason: validation.reason,
        rawText,
      };
    }

    return {
      ok: true as const,
      rawText,
      outputJson: stableStringify(scrubbed),
    };
  },
});
